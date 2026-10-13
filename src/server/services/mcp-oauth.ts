import { randomBytes } from "node:crypto";
import {
	auth,
	type OAuthAuthorizationServerInformation,
	type OAuthClientInformation,
	type OAuthClientProvider,
	type OAuthTokens,
} from "@ai-sdk/mcp";
import { seal, unseal } from "#/server/auth/token-vault";
import {
	mcpServerForOwner,
	saveMcpOAuth,
	saveMcpOAuthState,
	takeMcpOAuthState,
} from "../adapters/mcp-servers";

/** What we keep per OAuth server, sealed: the registered client and the user's tokens. */
type OAuthRecord = {
	client?: OAuthClientInformation;
	dynamic?: boolean;
	tokens?: OAuthTokens;
	authorizationServer?: OAuthAuthorizationServerInformation;
};

export class McpSignInRequired extends Error {
	constructor(readonly authorizationUrl?: URL) {
		super("This MCP server needs sign-in.");
	}
}

export const mcpOAuthRedirectUrl = (appUrl: string) =>
	new URL("/api/mcp/oauth/callback", appUrl).toString();

export async function readOAuthRecord(sealed: string | null) {
	return sealed ? (JSON.parse(await unseal(sealed)) as OAuthRecord) : {};
}

/**
 * The MCP SDK's OAuth client, backed by our sealed storage. During a turn it
 * refreshes tokens silently; it never redirects (the user isn't there), so a
 * server that needs a fresh sign-in is reported as unavailable instead.
 */
export function storedOAuthProvider(input: {
	record: OAuthRecord;
	redirectUrl: string;
	persist: (record: OAuthRecord) => Promise<void>;
	verifier?: string;
	state?: string;
}): OAuthClientProvider & { authorizationUrl?: URL; verifier?: string } {
	const record = input.record;
	const save = () => input.persist(record);
	const provider: OAuthClientProvider & {
		authorizationUrl?: URL;
		verifier?: string;
	} = {
		verifier: input.verifier,
		get redirectUrl() {
			return input.redirectUrl;
		},
		get clientMetadata() {
			return {
				client_name: "ytimesy",
				redirect_uris: [input.redirectUrl],
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				token_endpoint_auth_method: "none",
			};
		},
		clientInformation: () => record.client,
		isClientInformationDynamicallyRegistered: () => record.dynamic === true,
		saveClientInformation: async (client) => {
			record.client = client;
			record.dynamic = true;
			await save();
		},
		authorizationServerInformation: () => record.authorizationServer,
		saveAuthorizationServerInformation: async (information) => {
			record.authorizationServer = information;
			await save();
		},
		tokens: () => record.tokens,
		saveTokens: async (tokens) => {
			record.tokens = tokens;
			await save();
		},
		redirectToAuthorization: (url) => {
			provider.authorizationUrl = url;
		},
		saveCodeVerifier: (verifier) => {
			provider.verifier = verifier;
		},
		codeVerifier: () => {
			if (!provider.verifier) throw new McpSignInRequired();
			return provider.verifier;
		},
		state: () => input.state ?? randomBytes(32).toString("base64url"),
		validateAuthorizationServerURL: (_server, authorizationServer) => {
			if (new URL(authorizationServer).protocol !== "https:")
				throw new Error("MCP authorization servers must use HTTPS.");
		},
		invalidateCredentials: async (scope) => {
			if (scope === "all" || scope === "client") {
				record.client = undefined;
				record.dynamic = undefined;
			}
			if (scope === "all" || scope === "tokens") record.tokens = undefined;
			await save();
		},
	};
	return provider;
}

const persistFor =
	(userId: string, serverId: string) => async (record: OAuthRecord) =>
		saveMcpOAuth(userId, serverId, await seal(JSON.stringify(record)));

/** Starts sign-in: returns the provider's authorization URL, or null if already signed in. */
export async function startMcpOAuth(input: {
	userId: string;
	serverId: string;
	appUrl: string;
	fetchFn?: typeof fetch;
}) {
	const server = await mcpServerForOwner(input.userId, input.serverId);
	if (server?.auth !== "oauth") throw new Error("MCP server not found.");
	const state = randomBytes(32).toString("base64url");
	const provider = storedOAuthProvider({
		record: await readOAuthRecord(server.sealedOAuth),
		redirectUrl: mcpOAuthRedirectUrl(input.appUrl),
		persist: persistFor(input.userId, server.id),
		state,
	});
	const result = await auth(provider, {
		serverUrl: server.url,
		fetchFn: input.fetchFn,
	});
	if (result === "AUTHORIZED") return null;
	if (!provider.authorizationUrl || !provider.verifier)
		throw new Error("The MCP server did not start sign-in.");
	await saveMcpOAuthState(input.userId, server.id, state, provider.verifier);
	return provider.authorizationUrl.toString();
}

/** Finishes sign-in from the provider's redirect. */
export async function finishMcpOAuth(input: {
	userId: string;
	state: string;
	code: string;
	issuer?: string;
	appUrl: string;
	fetchFn?: typeof fetch;
}) {
	const pending = await takeMcpOAuthState(input.userId, input.state);
	if (!pending) throw new Error("Sign-in expired. Start again.");
	const server = await mcpServerForOwner(input.userId, pending.serverId);
	if (server?.auth !== "oauth") throw new Error("MCP server not found.");
	const provider = storedOAuthProvider({
		record: await readOAuthRecord(server.sealedOAuth),
		redirectUrl: mcpOAuthRedirectUrl(input.appUrl),
		persist: persistFor(input.userId, server.id),
		verifier: pending.verifier,
		state: input.state,
	});
	const result = await auth(provider, {
		serverUrl: server.url,
		authorizationCode: input.code,
		callbackState: input.state,
		callbackIssuer: input.issuer,
		fetchFn: input.fetchFn,
	});
	if (result !== "AUTHORIZED") throw new Error("Sign-in did not complete.");
	return server.id;
}

/** The provider a turn uses: stored tokens, silent refresh, no redirects. */
export async function turnOAuthProvider(input: {
	userId: string;
	serverId: string;
	sealedOAuth: string | null;
	appUrl: string;
}) {
	return storedOAuthProvider({
		record: await readOAuthRecord(input.sealedOAuth),
		redirectUrl: mcpOAuthRedirectUrl(input.appUrl),
		persist: persistFor(input.userId, input.serverId),
	});
}

/** True when the server answers an unauthenticated MCP request with 401 (MCP authorization). */
export async function requiresOAuth(
	url: string,
	fetchFn: typeof fetch = fetch,
) {
	try {
		const response = await fetchFn(url, {
			method: "POST",
			redirect: "manual",
			signal: AbortSignal.timeout(10_000),
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "ytimesy", version: "1" },
				},
			}),
		});
		await response.body?.cancel();
		return response.status === 401;
	} catch {
		return false;
	}
}
