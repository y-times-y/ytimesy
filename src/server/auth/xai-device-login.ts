import { z } from "zod";
import type { ConnectedModel } from "#/domain/model-connection";
import {
	XAI_API_BASE_URL,
	xaiSubscriptionEnabled,
	xaiSubscriptionModels,
} from "#/domain/xai-subscription";
import { database } from "../adapters/database";
import { discoverConnectionModels } from "../adapters/model-catalog";
import { modelEndpointTransport } from "../adapters/model-endpoint";
import { seal, unseal } from "./token-vault";
import {
	postXaiOAuth,
	XAI_DEVICE_GRANT,
	XAI_OAUTH_CLIENT_ID,
	XAI_OAUTH_REFERRER,
	XAI_OAUTH_SCOPE,
	xaiOAuthJson,
	xaiTokenResponse,
} from "./xai-oauth";
import { saveXaiSubscription } from "./xai-subscription";

/**
 * SuperGrok sign-in with xAI's device authorization grant, run by the web
 * server (no loopback, no VM): the user approves a code on xAI's page,
 * and the browser's polling advances the login until the tokens are sealed
 * into the user's SuperGrok model connection.
 */
export type XaiDeviceLogin =
	| { readonly status: "none" }
	| {
			readonly status: "pending";
			readonly userCode: string;
			/** Opens xAI's page; carries the code when xAI sends one. */
			readonly verificationUrl: string;
	  }
	| { readonly status: "connected" }
	| { readonly status: "failed"; readonly message: string };

const PURPOSE = "xai-device-login";
const LOGIN_LIFETIME_MS = 15 * 60_000;
/** OpenCode and Kilo wait this much past xAI's interval between polls. */
const POLL_SAFETY_MARGIN_MS = 3_000;

const pendingLogin = z.object({
	deviceCode: z.string().min(1),
	userCode: z.string().min(1),
	verificationUrl: z.string().url(),
	intervalMs: z.number().positive(),
	expiresAt: z.number(),
	nextPollAt: z.number(),
});
type PendingLogin = z.infer<typeof pendingLogin>;

const deviceCodeResponse = z.object({
	device_code: z.string().min(1),
	user_code: z.string().min(1),
	verification_uri: z.string().url(),
	verification_uri_complete: z.string().url().nullish(),
	expires_in: z.number().positive().nullish(),
	interval: z.number().positive().nullish(),
});
const deviceError = z.object({
	error: z.string().optional(),
	error_description: z.string().optional(),
});

function disabled(): never {
	throw new Error("Grok sign-in is not available.");
}

function pendingView(login: PendingLogin): XaiDeviceLogin {
	return {
		status: "pending",
		userCode: login.userCode,
		verificationUrl: login.verificationUrl,
	};
}

/** Only an https link on xAI's own domain is shown to the user. */
function xaiPage(value: string): string {
	const url = new URL(value);
	if (
		url.protocol !== "https:" ||
		!(url.hostname === "x.ai" || url.hostname.endsWith(".x.ai"))
	)
		throw new Error("xAI sign-in returned an unexpected page.");
	return url.href;
}

async function openPending(sealed: string | null | undefined, userId: string) {
	if (!sealed) return null;
	try {
		const parsed = pendingLogin.safeParse(
			JSON.parse(await unseal(sealed, { purpose: PURPOSE, userId })),
		);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/** The pending sign-in, from the database only (no xAI request). */
export async function readXaiDeviceLogin(
	userId: string,
): Promise<XaiDeviceLogin> {
	if (!xaiSubscriptionEnabled()) return { status: "none" };
	const row = (
		await database().query<{ sealed_login: string }>(
			"select sealed_login from xai_device_login where user_id=$1",
			[userId],
		)
	).rows[0];
	const login = await openPending(row?.sealed_login, userId);
	return login && login.expiresAt > Date.now()
		? pendingView(login)
		: { status: "none" };
}

/** Starts a sign-in, or returns the one already waiting for approval. */
export async function startXaiDeviceLogin(
	userId: string,
): Promise<XaiDeviceLogin> {
	if (!xaiSubscriptionEnabled()) disabled();
	const existing = await readXaiDeviceLogin(userId);
	if (existing.status === "pending") return existing;
	let response: Response;
	try {
		// OpenCode's device request: client_id, scope and its referrer.
		response = await postXaiOAuth("/device/code", {
			client_id: XAI_OAUTH_CLIENT_ID,
			scope: XAI_OAUTH_SCOPE,
			referrer: XAI_OAUTH_REFERRER,
		});
	} catch {
		throw new Error("Could not reach xAI; retry shortly.");
	}
	if (!response.ok) {
		await response.body?.cancel().catch(() => {});
		throw new Error("Could not start xAI sign-in; retry shortly.");
	}
	const code = deviceCodeResponse.parse(await xaiOAuthJson(response));
	const now = Date.now();
	const login: PendingLogin = {
		deviceCode: code.device_code,
		userCode: code.user_code,
		verificationUrl: xaiPage(
			code.verification_uri_complete ?? code.verification_uri,
		),
		intervalMs: Math.max((code.interval ?? 5) * 1000, 1000),
		expiresAt: Math.min(
			now + (code.expires_in ?? 300) * 1000,
			now + LOGIN_LIFETIME_MS,
		),
		nextPollAt: now,
	};
	await database().query(
		`insert into xai_device_login(user_id,sealed_login) values($1,$2)
		 on conflict(user_id) do update set sealed_login=excluded.sealed_login,updated_at=now()`,
		[userId, await seal(JSON.stringify(login), { purpose: PURPOSE, userId })],
	);
	return pendingView(login);
}

/** xAI's model list for the new token; null when the token cannot read it. */
async function discoverModels(
	accessToken: string,
): Promise<ConnectedModel[] | null> {
	const transport = modelEndpointTransport(XAI_API_BASE_URL);
	try {
		return await discoverConnectionModels(
			{
				provider: "compatible",
				baseUrl: XAI_API_BASE_URL,
				apiKey: accessToken,
			},
			transport.fetch,
		);
	} catch {
		return null;
	} finally {
		await transport.close().catch(() => {});
	}
}

/**
 * Polls xAI once, at most at the interval it asked for. Holds the pending
 * row so concurrent tabs cannot redeem the same device code twice.
 */
export async function advanceXaiDeviceLogin(
	userId: string,
): Promise<XaiDeviceLogin> {
	if (!xaiSubscriptionEnabled()) disabled();
	const client = await database().connect();
	try {
		await client.query("begin");
		const row = (
			await client.query<{ sealed_login: string }>(
				"select sealed_login from xai_device_login where user_id=$1 for update",
				[userId],
			)
		).rows[0];
		const login = await openPending(row?.sealed_login, userId);
		const finish = async (result: XaiDeviceLogin) => {
			if (row)
				await client.query("delete from xai_device_login where user_id=$1", [
					userId,
				]);
			await client.query("commit");
			return result;
		};
		const keep = async (next: PendingLogin) => {
			await client.query(
				"update xai_device_login set sealed_login=$2,updated_at=now() where user_id=$1",
				[
					userId,
					await seal(JSON.stringify(next), { purpose: PURPOSE, userId }),
				],
			);
			await client.query("commit");
			return pendingView(next);
		};
		if (!login) {
			const connected = (
				await client.query(
					"select 1 from model_connection where user_id=$1 and kind='xai-subscription' and status='ready'",
					[userId],
				)
			).rows.length;
			return await finish(
				connected ? { status: "connected" } : { status: "none" },
			);
		}
		const now = Date.now();
		if (login.expiresAt <= now)
			return await finish({
				status: "failed",
				message: "The xAI code expired. Sign in again.",
			});
		if (now < login.nextPollAt) {
			await client.query("commit");
			return pendingView(login);
		}
		let poll: Response;
		try {
			poll = await postXaiOAuth("/token", {
				grant_type: XAI_DEVICE_GRANT,
				client_id: XAI_OAUTH_CLIENT_ID,
				device_code: login.deviceCode,
			});
		} catch {
			// Unreachable for now: poll again next interval.
			return await keep({
				...login,
				nextPollAt: now + login.intervalMs + POLL_SAFETY_MARGIN_MS,
			});
		}
		if (!poll.ok) {
			const error = deviceError.safeParse(
				await xaiOAuthJson(poll).catch(() => ({})),
			);
			const code = error.success ? error.data.error : undefined;
			// RFC 8628 §3.5: pending keeps the interval; slow_down adds 5 s.
			if (code === "authorization_pending")
				return await keep({
					...login,
					nextPollAt: now + login.intervalMs + POLL_SAFETY_MARGIN_MS,
				});
			if (code === "slow_down") {
				const intervalMs = login.intervalMs + 5_000;
				return await keep({
					...login,
					intervalMs,
					nextPollAt: now + intervalMs + POLL_SAFETY_MARGIN_MS,
				});
			}
			return await finish({
				status: "failed",
				message:
					code === "access_denied" || code === "authorization_denied"
						? "xAI sign-in was declined. Sign in again."
						: code === "expired_token"
							? "The xAI code expired. Sign in again."
							: "xAI sign-in could not be completed. Sign in again.",
			});
		}
		const tokens = xaiTokenResponse.safeParse(
			await xaiOAuthJson(poll).catch(() => null),
		);
		if (!tokens.success || !tokens.data.refresh_token)
			return await finish({
				status: "failed",
				message: "xAI returned an incomplete sign-in. Sign in again.",
			});
		const models = xaiSubscriptionModels(
			await discoverModels(tokens.data.access_token),
		);
		await saveXaiSubscription(client, userId, tokens.data, models);
		return await finish({ status: "connected" });
	} catch (cause) {
		await client.query("rollback").catch(() => undefined);
		throw cause;
	} finally {
		client.release();
	}
}
