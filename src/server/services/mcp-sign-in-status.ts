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
	readOAuthRecord,
	storedOAuthProvider,
} from "./mcp-oauth";

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
	const record = await readOAuthRecord(input.sealedOAuth);
	if (!record.tokens?.access_token) return "needs-sign-in";
	const provider = storedOAuthProvider({
		record,
		redirectUrl: mcpOAuthRedirectUrl(input.appUrl),
		persist: async (next) =>
			saveMcpOAuth(
				input.userId,
				input.serverId,
				await seal(JSON.stringify(next)),
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
							signIn: await mcpSignInState({
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
