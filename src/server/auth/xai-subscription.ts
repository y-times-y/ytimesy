import { randomUUID } from "node:crypto";
import { z } from "zod";
import { XaiSubscriptionUnavailable } from "#/domain/api-turn-failure";
import type { ConnectedModel } from "#/domain/model-connection";
import {
	XAI_API_BASE_URL,
	XAI_SUBSCRIPTION_LABEL,
	type XaiSubscriptionStatus,
	type XaiSubscriptionView,
	xaiSubscriptionEnabled,
} from "#/domain/xai-subscription";
import { database } from "../adapters/database";
import { seal, unseal } from "./token-vault";
import {
	postXaiOAuth,
	XAI_OAUTH_CLIENT_ID,
	type XaiTokenResponse,
	xaiOAuthJson,
	xaiTokenExpiresAt,
	xaiTokenResponse,
} from "./xai-oauth";

/**
 * The SuperGrok subscription's OAuth tokens, sealed per user in its
 * model_connection row (never in a VM, never logged). Turns read the access
 * token at the edge; a refresh rotates the pair under the row's lock so two
 * steps never replay the same refresh token.
 */
const PURPOSE = "xai-subscription";
/** Refresh this long before expiry, so a long request never starts on a dying token. */
const REFRESH_SKEW_MS = 10 * 60_000;

const sealedTokens = z.object({
	connectionId: z.string(),
	userId: z.string(),
	accessToken: z.string().min(1),
	refreshToken: z.string().min(1),
	expiresAt: z.number(),
});
type SealedTokens = z.infer<typeof sealedTokens>;

export type XaiAccessToken = {
	readonly token: string;
	readonly expiresAt: number;
};

async function sealTokens(tokens: SealedTokens) {
	return seal(JSON.stringify(tokens), {
		purpose: PURPOSE,
		userId: tokens.userId,
	});
}

async function openTokens(
	sealed: string,
	userId: string,
	connectionId: string,
): Promise<SealedTokens> {
	const value = sealedTokens.parse(
		JSON.parse(
			// A blob sealed for another user fails authentication here.
			await unseal(sealed, { purpose: PURPOSE, userId }).catch(() => {
				throw new Error("SuperGrok credential ownership mismatch.");
			}),
		),
	);
	if (value.userId !== userId || value.connectionId !== connectionId)
		throw new Error("SuperGrok credential ownership mismatch.");
	return value;
}

function sealedFrom(
	userId: string,
	connectionId: string,
	tokens: XaiTokenResponse,
	previousRefresh?: string,
): SealedTokens {
	const refreshToken = tokens.refresh_token ?? previousRefresh;
	if (!refreshToken)
		throw new Error("xAI returned a sign-in without a refresh token.");
	return {
		connectionId,
		userId,
		accessToken: tokens.access_token,
		refreshToken,
		expiresAt: xaiTokenExpiresAt(tokens),
	};
}

type Row = { id: string; status: XaiSubscriptionStatus; sealed: string };

const SELECT_ROW = `select id,status,sealed_credential as sealed from model_connection
	where user_id=$1 and id=$2 and kind='xai-subscription'`;

function ready(row: Row | undefined): Row {
	if (!row) throw new Error("The SuperGrok subscription was disconnected.");
	if (row.status !== "ready") throw new XaiSubscriptionUnavailable(row.status);
	return row;
}

/** The refresh grant (OpenCode's and Kilo's): grant_type, refresh_token, client_id. */
export async function refreshXaiTokens(
	refreshToken: string,
): Promise<XaiTokenResponse> {
	let response: Response;
	try {
		response = await postXaiOAuth("/token", {
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: XAI_OAUTH_CLIENT_ID,
		});
	} catch {
		throw new XaiSubscriptionUnavailable("unavailable");
	}
	if (!response.ok) {
		await response.body?.cancel().catch(() => {});
		// 400/401/403 reject the grant itself; anything else may be transient.
		throw new XaiSubscriptionUnavailable(
			[400, 401, 403].includes(response.status) ? "reconnect" : "unavailable",
		);
	}
	try {
		return xaiTokenResponse.parse(await xaiOAuthJson(response));
	} catch {
		throw new XaiSubscriptionUnavailable("unavailable");
	}
}

/**
 * A current access token for the connection. A fresh one is read without a
 * lock; an expiring one (or `forceRefresh`, after a 401) is refreshed under
 * the row lock, keeping the connection's revision so queued turns still match.
 */
export async function xaiSubscriptionAccessToken(
	userId: string,
	connectionId: string,
	forceRefresh = false,
): Promise<XaiAccessToken> {
	if (!forceRefresh) {
		const row = ready(
			(await database().query<Row>(SELECT_ROW, [userId, connectionId])).rows[0],
		);
		const tokens = await openTokens(row.sealed, userId, connectionId);
		if (tokens.expiresAt >= Date.now() + REFRESH_SKEW_MS)
			return { token: tokens.accessToken, expiresAt: tokens.expiresAt };
	}
	const client = await database().connect();
	try {
		await client.query("begin");
		const row = ready(
			(
				await client.query<Row>(`${SELECT_ROW} for update`, [
					userId,
					connectionId,
				])
			).rows[0],
		);
		let tokens = await openTokens(row.sealed, userId, connectionId);
		// Another step may have refreshed while this one waited for the lock.
		if (forceRefresh || tokens.expiresAt < Date.now() + REFRESH_SKEW_MS) {
			try {
				tokens = sealedFrom(
					userId,
					connectionId,
					await refreshXaiTokens(tokens.refreshToken),
					tokens.refreshToken,
				);
			} catch (error) {
				// A dead grant is recorded, so the UI asks for sign-in instead of
				// every step retrying it.
				if (
					error instanceof XaiSubscriptionUnavailable &&
					error.reason === "reconnect"
				) {
					await client.query(
						"update model_connection set status='reconnect',updated_at=now() where user_id=$1 and id=$2 and kind='xai-subscription'",
						[userId, connectionId],
					);
					await client.query("commit");
				}
				throw error;
			}
			await client.query(
				"update model_connection set sealed_credential=$3,updated_at=now() where user_id=$1 and id=$2 and kind='xai-subscription'",
				[userId, connectionId, await sealTokens(tokens)],
			);
		}
		await client.query("commit");
		return { token: tokens.accessToken, expiresAt: tokens.expiresAt };
	} catch (cause) {
		await client.query("rollback").catch(() => undefined);
		throw cause;
	} finally {
		client.release();
	}
}

/** Records that xAI refused the connection; it waits until the user signs in again. */
export async function markXaiSubscription(
	userId: string,
	connectionId: string,
	status: Exclude<XaiSubscriptionStatus, "ready">,
) {
	await database().query(
		"update model_connection set status=$3,updated_at=now() where user_id=$1 and id=$2 and kind='xai-subscription'",
		[userId, connectionId, status],
	);
}

/**
 * The fetch every request of a SuperGrok turn goes through: the user's
 * bearer token replaces the placeholder key, a 401 refreshes once and
 * retries, and a refusal (401 again, or 403) marks the connection and fails
 * with XaiSubscriptionUnavailable, which moves the turn to another route.
 */
export function xaiSubscriptionFetch(
	userId: string,
	connectionId: string,
	transport: typeof globalThis.fetch,
): typeof globalThis.fetch {
	let current: XaiAccessToken | undefined;
	const token = async (force = false) => {
		if (force || !current || current.expiresAt < Date.now() + REFRESH_SKEW_MS)
			current = await xaiSubscriptionAccessToken(userId, connectionId, force);
		return current.token;
	};
	return async (input, init) => {
		const send = async (bearer: string) => {
			const headers = new Headers(
				input instanceof Request ? input.headers : undefined,
			);
			new Headers(init?.headers).forEach((value, key) => {
				headers.set(key, value);
			});
			headers.set("authorization", `Bearer ${bearer}`);
			return transport(input, { ...init, headers });
		};
		let response = await send(await token());
		// A body that can be sent again (the SDKs send JSON strings) is retried
		// once on a refreshed token; xAI may have revoked the old one early.
		if (
			response.status === 401 &&
			(init?.body === undefined || typeof init.body === "string")
		) {
			await response.body?.cancel().catch(() => {});
			response = await send(await token(true));
		}
		if (response.status === 401 || response.status === 403) {
			await response.body?.cancel().catch(() => {});
			const status = response.status === 401 ? "reconnect" : "not-eligible";
			await markXaiSubscription(userId, connectionId, status).catch(() => {});
			throw new XaiSubscriptionUnavailable(status);
		}
		return response;
	};
}

/**
 * Stores a completed sign-in as the user's one SuperGrok connection. A
 * reconnect keeps the connection's id (fallback order, picker choices) and
 * gets a new revision, as replacing an API key does.
 */
export async function saveXaiSubscription(
	client: { query: ReturnType<typeof database>["query"] },
	userId: string,
	tokens: XaiTokenResponse,
	models: readonly ConnectedModel[],
): Promise<string> {
	const existing = (
		await client.query<{ id: string }>(
			"select id from model_connection where user_id=$1 and kind='xai-subscription'",
			[userId],
		)
	).rows[0];
	const id = existing?.id ?? randomUUID();
	const sealed = await sealTokens(sealedFrom(userId, id, tokens));
	await client.query(
		`insert into model_connection(id,user_id,provider,label,base_url,sealed_credential,models,revision,kind,status)
		 values($1,$2,'compatible',$3,$4,$5,$6::jsonb,$7,'xai-subscription','ready')
		 on conflict (id) do update set sealed_credential=excluded.sealed_credential,
		 models=excluded.models,revision=excluded.revision,status='ready',updated_at=now()`,
		[
			id,
			userId,
			XAI_SUBSCRIPTION_LABEL,
			XAI_API_BASE_URL,
			sealed,
			JSON.stringify(models),
			randomUUID(),
		],
	);
	return id;
}

/** What Settings shows; undefined while the feature is off. */
export async function loadXaiSubscription(
	userId: string,
): Promise<XaiSubscriptionView | undefined> {
	if (!xaiSubscriptionEnabled()) return undefined;
	const row = (
		await database().query<{
			id: string;
			status: XaiSubscriptionStatus;
			models: unknown;
		}>(
			"select id,status,models from model_connection where user_id=$1 and kind='xai-subscription'",
			[userId],
		)
	).rows[0];
	if (!row) return { status: "disconnected" };
	return {
		status: row.status,
		connectionId: row.id,
		modelCount: Array.isArray(row.models) ? row.models.length : 0,
	};
}

/** Signs out: the tokens and any pending sign-in are deleted. */
export async function disconnectXaiSubscription(userId: string) {
	await database().query(
		"delete from model_connection where user_id=$1 and kind='xai-subscription'",
		[userId],
	);
	await database().query("delete from xai_device_login where user_id=$1", [
		userId,
	]);
}
