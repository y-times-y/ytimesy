import { createHash } from "node:crypto";
import { createMCPClient } from "@ai-sdk/mcp";
import {
	listMcpServersWithOAuth,
	type McpSignInState,
	type PublicMcpServer,
	saveMcpOAuth,
} from "../adapters/mcp-servers";
import { redirectRefusingFetch } from "../adapters/workers-fetch";
import { seal } from "../auth/token-vault";
import { serverConfig } from "../config";
import {
	mcpOAuthRedirectUrl,
	type OAuthRecord,
	readOAuthRecord,
	storedOAuthProvider,
} from "./mcp-oauth";
import { mcpOAuthAppCredentials, mcpOAuthAppFor } from "./mcp-oauth-client";

/**
 * Without tokens: "needs-token" when the last sign-in start found no way to
 * sign in, unless the owner has since set up the service's app.
 */
export function signedOutState(
	record: OAuthRecord,
	env?: Record<string, string | undefined>,
): McpSignInState {
	const unavailable = record.unavailable;
	if (!unavailable) return "needs-sign-in";
	const app = mcpOAuthAppFor(unavailable.authorizationServer);
	return app && mcpOAuthAppCredentials(app.service, env)
		? "needs-sign-in"
		: "needs-token";
}

const CHECK_TIMEOUT_MS = 8_000;

/**
 * Whether the user's stored sign-in actually works: connects with their token
 * (refreshing it if the server allows) instead of trusting that a record exists.
 * A registered client without tokens, a revoked token, or a refresh the server
 * rejects all read as "needs-sign-in"; a server we cannot reach is reported as such.
 */
export async function mcpSignInState(input: {
	userId: string;
	serverId: string;
	url: string;
	sealedOAuth: string | null;
	appUrl: string;
	fetchFn?: typeof fetch;
}): Promise<McpSignInState> {
	const record = await readOAuthRecord(input.sealedOAuth, input.userId);
	if (!record.tokens?.access_token) return signedOutState(record);
	const provider = storedOAuthProvider({
		record,
		redirectUrl: mcpOAuthRedirectUrl(input.appUrl),
		persist: async (next) =>
			saveMcpOAuth(
				input.userId,
				input.serverId,
				await seal(JSON.stringify(next), {
					purpose: "mcp-oauth",
					userId: input.userId,
				}),
			),
	});
	try {
		const client = await createMCPClient({
			transport: {
				type: "http",
				url: input.url,
				authProvider: provider,
				fetch: redirectRefusingFetch(input.fetchFn),
			},
			initializationOptions: { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) },
		});
		await client.close();
		return "signed-in";
	} catch {
		// The SDK asks for a new authorization only when the token was refused.
		return provider.authorizationUrl || !record.tokens?.access_token
			? "needs-sign-in"
			: "unreachable";
	}
}

/**
 * A sign-in check's answer is reused for this long. Each check connects to the
 * MCP server (up to CHECK_TIMEOUT_MS), and Settings reads the list on every
 * open. The answer is display state, never an authorization: tools connect
 * with the stored token themselves.
 */
export const SIGN_IN_CHECK_TTL_MS = 60_000;
const checks = new Map<string, { state: McpSignInState; until: number }>();

/**
 * Keyed by the stored sign-in itself: signing in, a refreshed token or a
 * changed URL is a new key, so a new sign-in is never shown as missing.
 */
function checkKey(input: {
	userId: string;
	serverId: string;
	url: string;
	sealedOAuth: string | null;
}) {
	return createHash("sha256")
		.update(
			JSON.stringify([
				input.userId,
				input.serverId,
				input.url,
				input.sealedOAuth,
			]),
		)
		.digest("base64url");
}

async function cachedSignInState(
	input: Parameters<typeof mcpSignInState>[0],
	now = Date.now(),
): Promise<McpSignInState> {
	const key = checkKey(input);
	const hit = checks.get(key);
	if (hit && hit.until > now) return hit.state;
	const state = await mcpSignInState(input);
	// An unreachable server is checked again next time.
	if (state === "unreachable") checks.delete(key);
	else {
		if (checks.size >= 1_000) checks.clear();
		checks.set(key, { state, until: Date.now() + SIGN_IN_CHECK_TTL_MS });
	}
	return state;
}

/** Test seam. */
export function forgetMcpSignInChecks() {
	checks.clear();
}

/** The user's MCP servers, with OAuth sign-in checked against each server. */
export async function listMcpServersChecked(
	userId: string,
): Promise<PublicMcpServer[]> {
	const appUrl = serverConfig().APP_URL;
	return Promise.all(
		(await listMcpServersWithOAuth(userId)).map(
			async ({ server, sealedOAuth }) =>
				server.auth === "oauth"
					? {
							...server,
							signIn: await cachedSignInState({
								userId,
								serverId: server.id,
								url: server.url,
								sealedOAuth,
								appUrl,
							}),
						}
					: server,
		),
	);
}
