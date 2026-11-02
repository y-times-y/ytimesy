import { z } from "zod";
import { readBoundedRequestBody } from "#/domain/bounded-request-body";
import { database } from "../adapters/database";
import {
	codexAccessTokenExpiresAt,
	codexPlanType,
	managedAuth,
} from "./codex-managed-auth";
import { CODEX_OAUTH_CLIENT_ID, CODEX_OAUTH_ISSUER } from "./codex-oauth";
import { seal, unseal } from "./token-vault";

/**
 * ChatGPT device-code sign-in, run by the web server over HTTPS (the flow the
 * Codex CLI's `login --device-auth` uses). No VM or CLI is involved: the user
 * approves a code at auth.openai.com, and the browser's polling advances the
 * login until the tokens land in the same sealed `agent_account` row that
 * refresh and every agent turn already read.
 */
export type CodexDeviceLogin =
	| { readonly status: "none" }
	| {
			readonly status: "pending";
			readonly userCode: string;
			readonly verificationUrl: string;
	  }
	| { readonly status: "connected" }
	| { readonly status: "failed"; readonly message: string };

const VERIFICATION_URL = `${CODEX_OAUTH_ISSUER}/codex/device`;
const LOGIN_LIFETIME_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

const pendingLogin = z.object({
	deviceAuthId: z.string().min(1),
	userCode: z.string().min(1),
	intervalSeconds: z.number().positive(),
	expiresAt: z.number(),
	nextPollAt: z.number(),
});
type PendingLogin = z.infer<typeof pendingLogin>;

const userCodeResponse = z.object({
	device_auth_id: z.string().min(1),
	user_code: z.string().min(1).optional(),
	usercode: z.string().min(1).optional(),
	interval: z.union([z.string(), z.number()]).optional(),
	expires_at: z.string().optional(),
});
const approvedResponse = z.object({
	authorization_code: z.string().min(1),
	code_verifier: z.string().min(1),
});
const exchangedTokens = z.object({
	id_token: z.string().min(1),
	access_token: z.string().min(1),
	refresh_token: z.string().min(1),
});

function post(path: string, body: Record<string, string>, form = false) {
	return fetch(`${CODEX_OAUTH_ISSUER}${path}`, {
		method: "POST",
		headers: {
			"content-type": form
				? "application/x-www-form-urlencoded"
				: "application/json",
		},
		body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
		redirect: "manual",
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
}

async function json(response: Response) {
	return JSON.parse(await readBoundedRequestBody(response, 64 * 1024));
}

function pendingView(login: PendingLogin): CodexDeviceLogin {
	return {
		status: "pending",
		userCode: login.userCode,
		verificationUrl: VERIFICATION_URL,
	};
}

async function openPending(sealed: string | null, userId: string) {
	if (!sealed) return null;
	// A pending login that no longer opens (sealed by an older build without its
	// binding) is no login: a fresh sign-in replaces it instead of failing forever.
	const opened = await unseal(sealed, {
		purpose: "codex-device-login",
		userId,
	}).catch(() => null);
	if (opened === null) return null;
	try {
		const parsed = pendingLogin.safeParse(JSON.parse(opened));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/** The pending login, from the database only (no OpenAI request). */
export async function readCodexDeviceLogin(
	userId: string,
): Promise<CodexDeviceLogin> {
	const row = (
		await database().query<{ encrypted_device_login: string | null }>(
			"select encrypted_device_login from agent_account where user_id=$1 and provider='codex'",
			[userId],
		)
	).rows[0];
	return deviceLoginFromSealed(row?.encrypted_device_login ?? null, userId);
}

/** readCodexDeviceLogin for a sealed login the caller already read. */
export async function deviceLoginFromSealed(
	sealed: string | null,
	userId: string,
): Promise<CodexDeviceLogin> {
	const login = await openPending(sealed, userId);
	return login && login.expiresAt > Date.now()
		? pendingView(login)
		: { status: "none" };
}

/** Starts a sign-in, or returns the one already waiting for approval. */
export async function startCodexDeviceLogin(
	userId: string,
): Promise<CodexDeviceLogin> {
	const existing = await readCodexDeviceLogin(userId);
	if (existing.status === "pending") return existing;
	const response = await post("/api/accounts/deviceauth/usercode", {
		client_id: CODEX_OAUTH_CLIENT_ID,
	});
	if (!response.ok) {
		await response.body?.cancel().catch(() => {});
		throw new Error(
			response.status === 404
				? "ChatGPT device sign-in is not available right now."
				: "Could not start ChatGPT sign-in; retry shortly.",
		);
	}
	const code = userCodeResponse.parse(await json(response));
	const userCode = code.user_code ?? code.usercode;
	if (!userCode) throw new Error("ChatGPT sign-in returned no code.");
	const now = Date.now();
	const reportedExpiry = code.expires_at ? Date.parse(code.expires_at) : NaN;
	const login: PendingLogin = {
		deviceAuthId: code.device_auth_id,
		userCode,
		intervalSeconds: Math.max(Number(code.interval) || 5, 1),
		expiresAt: Math.min(
			Number.isFinite(reportedExpiry) ? reportedExpiry : Infinity,
			now + LOGIN_LIFETIME_MS,
		),
		nextPollAt: now,
	};
	// A connected or expired account keeps its status until the new login lands.
	await database().query(
		`insert into agent_account(user_id,provider,status,encrypted_device_login)
		 values($1,'codex','disconnected',$2)
		 on conflict(user_id,provider) do update set
		 encrypted_device_login=excluded.encrypted_device_login,updated_at=now()`,
		[
			userId,
			await seal(JSON.stringify(login), {
				purpose: "codex-device-login",
				userId,
			}),
		],
	);
	return pendingView(login);
}

/**
 * Checks once whether the user approved the code, at most every poll interval
 * the issuer asked for. Holds the account row so concurrent tabs cannot
 * exchange the same authorization code twice.
 */
export async function advanceCodexDeviceLogin(
	userId: string,
): Promise<CodexDeviceLogin> {
	const client = await database().connect();
	try {
		await client.query("begin");
		const row = (
			await client.query<{
				status: string;
				encrypted_codex_auth: string | null;
				encrypted_device_login: string | null;
			}>(
				"select status,encrypted_codex_auth,encrypted_device_login from agent_account where user_id=$1 and provider='codex' for update",
				[userId],
			)
		).rows[0];
		const login = await openPending(
			row?.encrypted_device_login ?? null,
			userId,
		);
		const finish = async (result: CodexDeviceLogin) => {
			if (row?.encrypted_device_login)
				await client.query(
					"update agent_account set encrypted_device_login=null,updated_at=now() where user_id=$1 and provider='codex'",
					[userId],
				);
			await client.query("commit");
			return result;
		};
		if (row?.status === "connected" && row.encrypted_codex_auth && !login)
			return await finish({ status: "connected" });
		if (!login) return await finish({ status: "none" });
		const now = Date.now();
		if (login.expiresAt <= now)
			return await finish({
				status: "failed",
				message: "The ChatGPT sign-in code expired. Sign in again.",
			});
		if (now < login.nextPollAt) {
			await client.query("commit");
			return pendingView(login);
		}
		const poll = await post("/api/accounts/deviceauth/token", {
			device_auth_id: login.deviceAuthId,
			user_code: login.userCode,
		});
		// The issuer answers 403/404 until the user approves the code.
		if (poll.status === 403 || poll.status === 404) {
			// Its error code says why (pending, not found, denied); never the ids.
			const reason = await poll
				.text()
				.then(
					(text) => /"code"\s*:\s*"([a-z_]{1,64})"/.exec(text)?.[1] ?? "none",
				)
				.catch(() => "unreadable");
			console.info("ChatGPT device sign-in still waiting.", {
				status: poll.status,
				reason,
				codeAgeSeconds: Math.round(
					(now - (login.expiresAt - 15 * 60_000)) / 1000,
				),
			});
			await client.query(
				"update agent_account set encrypted_device_login=$2,updated_at=now() where user_id=$1 and provider='codex'",
				[
					userId,
					// The same binding the login was first sealed with (openPending).
					await seal(
						JSON.stringify({
							...login,
							nextPollAt: now + login.intervalSeconds * 1000,
						}),
						{ purpose: "codex-device-login", userId },
					),
				],
			);
			await client.query("commit");
			return pendingView(login);
		}
		if (!poll.ok) {
			await poll.body?.cancel().catch(() => {});
			console.warn("ChatGPT device sign-in refused.", { status: poll.status });
			return await finish({
				status: "failed",
				message: "ChatGPT sign-in was not approved. Sign in again.",
			});
		}
		const approved = approvedResponse.parse(await json(poll));
		const exchange = await post(
			"/oauth/token",
			{
				grant_type: "authorization_code",
				code: approved.authorization_code,
				redirect_uri: `${CODEX_OAUTH_ISSUER}/deviceauth/callback`,
				client_id: CODEX_OAUTH_CLIENT_ID,
				code_verifier: approved.code_verifier,
			},
			true,
		);
		if (!exchange.ok) {
			await exchange.body?.cancel().catch(() => {});
			console.warn("ChatGPT sign-in token exchange failed.", {
				status: exchange.status,
			});
			return await finish({
				status: "failed",
				message: "ChatGPT sign-in could not be completed. Sign in again.",
			});
		}
		const tokens = exchangedTokens.parse(await json(exchange));
		const auth = managedAuth({
			auth_mode: "chatgpt",
			tokens: {
				id_token: tokens.id_token,
				access_token: tokens.access_token,
				refresh_token: tokens.refresh_token,
				account_id: chatgptAccountId(tokens.id_token, tokens.access_token),
			},
		});
		if (codexAccessTokenExpiresAt(auth) < Date.now() + 60_000)
			return await finish({
				status: "failed",
				message: "ChatGPT returned an expired login. Sign in again.",
			});
		await client.query(
			`update agent_account set status='connected',encrypted_codex_auth=$2,
			 plan_type=$3,message=null,encrypted_device_login=null,updated_at=now()
			 where user_id=$1 and provider='codex'`,
			[
				userId,
				await seal(JSON.stringify(auth), { purpose: "codex-auth", userId }),
				codexPlanType(auth),
			],
		);
		await client.query("commit");
		return { status: "connected" };
	} catch (cause) {
		await client.query("rollback").catch(() => undefined);
		throw cause;
	} finally {
		client.release();
	}
}

/** ChatGPT's account id rides in the token claims, as the Codex CLI reads it. */
function chatgptAccountId(...jwts: readonly string[]): string {
	for (const jwt of jwts) {
		try {
			const claims = JSON.parse(
				Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString(),
			) as Record<string, unknown>;
			const account = claims["https://api.openai.com/auth"] as
				| Record<string, unknown>
				| undefined;
			if (typeof account?.chatgpt_account_id === "string")
				return account.chatgpt_account_id;
		} catch {
			// Try the next token; managedAuth rejects a login without an account.
		}
	}
	return "";
}
