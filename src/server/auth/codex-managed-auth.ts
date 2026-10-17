import { CodexReconnectRequired } from "#/domain/api-turn-failure";
import { database } from "../adapters/database";
import { codexCredentialUserId } from "../adapters/dev-eval-users";
import { CODEX_OAUTH_CLIENT_ID, CODEX_OAUTH_ISSUER } from "./codex-oauth";
import { seal, unseal } from "./token-vault";

type ManagedCodexAuth = {
	readonly auth_mode: "chatgpt";
	readonly tokens: {
		readonly access_token: string;
		readonly refresh_token: string;
		readonly account_id: string;
		readonly id_token?: string;
	};
};

type CodexExternalTokens = {
	readonly accessToken: string;
	readonly chatgptAccountId: string;
	readonly chatgptPlanType?: string;
};

export function managedAuth(value: unknown): ManagedCodexAuth {
	if (!value || typeof value !== "object")
		throw new Error("Codex login is missing.");
	const record = value as Record<string, unknown>;
	const tokens = record.tokens as Record<string, unknown> | undefined;
	if (
		record.auth_mode !== "chatgpt" ||
		!tokens ||
		![tokens.access_token, tokens.refresh_token, tokens.account_id].every(
			(value) => typeof value === "string" && value.length > 0,
		)
	) {
		throw new Error("Codex login is incomplete; reconnect Codex.");
	}
	return value as ManagedCodexAuth;
}

/** ChatGPT embeds the current plan in each access token. */
export function codexPlanType(auth: ManagedCodexAuth): string | null {
	try {
		const claims = JSON.parse(
			Buffer.from(
				auth.tokens.access_token.split(".")[1] ?? "",
				"base64url",
			).toString(),
		) as Record<string, unknown>;
		const account = claims["https://api.openai.com/auth"];
		if (
			account &&
			typeof account === "object" &&
			"chatgpt_plan_type" in account
		)
			return typeof account.chatgpt_plan_type === "string"
				? account.chatgpt_plan_type
				: null;
	} catch {
		// The plan is display metadata; expiry checks validate the token itself.
	}
	return null;
}

export function codexAccessTokenExpiresAt(auth: ManagedCodexAuth): number {
	const payload = auth.tokens.access_token.split(".")[1];
	if (!payload)
		throw new Error("Codex access token is invalid; reconnect Codex.");
	try {
		const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
			exp?: unknown;
		};
		if (typeof claims.exp === "number" && Number.isFinite(claims.exp)) {
			return claims.exp * 1000;
		}
	} catch {
		// A malformed token must never be treated as fresh.
	}
	throw new Error("Codex access token is invalid; reconnect Codex.");
}

export async function hasManagedCodexAuth(userId: string): Promise<boolean> {
	const result = await database().query(
		"select 1 from agent_account where user_id=$1 and provider='codex' and status='connected' and encrypted_codex_auth is not null",
		[userId],
	);
	return (result.rowCount ?? 0) > 0;
}

function externalTokens(auth: ManagedCodexAuth): CodexExternalTokens {
	return {
		accessToken: auth.tokens.access_token,
		chatgptAccountId: auth.tokens.account_id,
	};
}

/**
 * Row lock makes refresh-token rotation single-writer across web/worker processes.
 * A current, unexpired token needs no rotation, so it is read without the lock.
 */
export async function codexExternalTokens(
	requestingUserId: string,
	forceRefresh = false,
): Promise<CodexExternalTokens> {
	// A development eval user borrows its owner's login: the owner's row is
	// read and refreshed, so a rotated refresh token never forks into a copy.
	const userId = await codexCredentialUserId(requestingUserId);
	if (!forceRefresh) {
		const { rows } = await database().query<{
			encrypted_codex_auth: string | null;
		}>(
			"select encrypted_codex_auth from agent_account where user_id=$1 and provider='codex' and status='connected'",
			[userId],
		);
		const sealed = rows[0]?.encrypted_codex_auth;
		if (!sealed) throw new Error("Connect Codex before starting this agent.");
		const auth = managedAuth(JSON.parse(await unseal(sealed)));
		if (codexAccessTokenExpiresAt(auth) >= Date.now() + 300_000)
			return externalTokens(auth);
	}
	return lockedExternalTokens(userId, forceRefresh);
}

async function lockedExternalTokens(
	userId: string,
	forceRefresh: boolean,
): Promise<CodexExternalTokens> {
	const client = await database().connect();
	try {
		await client.query("begin");
		const result = await client.query<{
			encrypted_codex_auth: string | null;
		}>(
			"select encrypted_codex_auth from agent_account where user_id=$1 and provider='codex' and status='connected' for update",
			[userId],
		);
		const row = result.rows[0];
		if (!row?.encrypted_codex_auth) {
			throw new Error("Connect Codex before starting this agent.");
		}
		let auth = managedAuth(JSON.parse(await unseal(row.encrypted_codex_auth)));
		if (
			forceRefresh ||
			codexAccessTokenExpiresAt(auth) < Date.now() + 300_000
		) {
			try {
				auth = await refreshManagedCodexAuth(auth);
			} catch (error) {
				// Persist the expired state so the UI asks for sign-in instead of every
				// request retrying a dead grant. The sealed login is kept for diagnosis.
				if (error instanceof CodexReconnectRequired) {
					await client.query(
						"update agent_account set status='expired',message=$2,updated_at=now() where user_id=$1 and provider='codex'",
						[
							userId,
							"Your Codex login expired or was revoked. Reconnect Codex.",
						],
					);
					await client.query("commit");
				}
				throw error;
			}
			// Plan changes surface on refresh; keep the displayed plan current.
			await client.query(
				"update agent_account set encrypted_codex_auth=$2,plan_type=coalesce($3,plan_type),updated_at=now() where user_id=$1 and provider='codex'",
				[userId, await seal(JSON.stringify(auth)), codexPlanType(auth)],
			);
		}
		await client.query("commit");
		return externalTokens(auth);
	} catch (cause) {
		await client.query("rollback").catch(() => undefined);
		throw cause;
	} finally {
		client.release();
	}
}

const refreshedCredentials = z.object({
	access_token: z.string().min(1),
	refresh_token: z.string().min(1).nullish(),
	id_token: z.string().min(1).nullish(),
});

/** Native Codex's refresh grant over HTTPS; persistence remains under the owner row lock. */
export async function refreshManagedCodexAuth(
	auth: ManagedCodexAuth,
): Promise<ManagedCodexAuth> {
	const response = await fetch(`${CODEX_OAUTH_ISSUER}/oauth/token`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			grant_type: "refresh_token",
			refresh_token: auth.tokens.refresh_token,
			client_id: CODEX_OAUTH_CLIENT_ID,
		}),
		redirect: "manual",
		signal: AbortSignal.timeout(25_000),
	});
	if (!response.ok) {
		await response.body?.cancel().catch(() => {});
		// 400/401/403 reject the grant itself; anything else may be transient.
		if ([400, 401, 403].includes(response.status))
			throw new CodexReconnectRequired();
		throw new Error(
			"Codex login refresh is temporarily unavailable; retry shortly.",
		);
	}
	let value: z.infer<typeof refreshedCredentials>;
	try {
		value = refreshedCredentials.parse(
			JSON.parse(await readBoundedRequestBody(response, 64 * 1024)),
		);
	} catch {
		throw new Error("Codex login refresh returned incomplete credentials.");
	}
	const updated = managedAuth({
		...auth,
		tokens: {
			...auth.tokens,
			access_token: value.access_token,
			refresh_token: value.refresh_token ?? auth.tokens.refresh_token,
			...(value.id_token ? { id_token: value.id_token } : {}),
		},
	});
	if (codexAccessTokenExpiresAt(updated) < Date.now() + 60_000)
		throw new CodexReconnectRequired();
	const claims = JSON.parse(
		Buffer.from(
			updated.tokens.access_token.split(".")[1],
			"base64url",
		).toString(),
	) as Record<string, unknown>;
	const account = claims["https://api.openai.com/auth"];
	if (
		account &&
		typeof account === "object" &&
		"chatgpt_account_id" in account &&
		account.chatgpt_account_id !== auth.tokens.account_id
	)
		throw new Error("Codex login account changed; reconnect Codex.");
	return updated;
}

import { z } from "zod";
import { readBoundedRequestBody } from "#/domain/bounded-request-body";
