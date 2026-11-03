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
import { redirectRefusingFetch } from "../adapters/workers-fetch";
import {
	chooseClientRegistration,
	fetchAuthorizationServerMetadata,
	McpSignInUnavailable,
	mcpOAuthAppCredentials,
} from "./mcp-oauth-client";

/** What we keep per OAuth server, sealed: the registered client and the user's tokens. */
export type OAuthRecord = {
	client?: OAuthClientInformation;
	dynamic?: boolean;
	/**
	 * Signs in with the owner's registered app for this service ("SLACK"). Its
	 * credentials are read from settings each time, never copied here.
	 */
	app?: string;
	tokens?: OAuthTokens;
	authorizationServer?: OAuthAuthorizationServerInformation;
	/** The last sign-in start found no way to get a client: the user needs a token. */
	unavailable?: { reason: "setup" | "token"; authorizationServer: string };
};

class McpSignInRequired extends Error {
	constructor(readonly authorizationUrl?: URL) {
		super("This MCP server needs sign-in.");
	}
}

export const mcpOAuthRedirectUrl = (appUrl: string) =>
	new URL("/api/mcp/oauth/callback", appUrl).toString();

/** Our Client ID Metadata Document: its URL is our client id where servers accept one. */
export const mcpClientMetadataUrl = (appUrl: string) =>
	new URL("/api/mcp/oauth/client-metadata", appUrl).toString();

export function mcpClientMetadataDocument(appUrl: string) {
	return {
		client_id: mcpClientMetadataUrl(appUrl),
		client_name: "ytimesy",
		client_uri: new URL("/", appUrl).toString(),
		redirect_uris: [mcpOAuthRedirectUrl(appUrl)],
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
	};
}

export async function readOAuthRecord(sealed: string | null, userId: string) {
	return sealed
		? (JSON.parse(
				await unseal(sealed, { purpose: "mcp-oauth", userId }),
			) as OAuthRecord)
		: {};
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
	/**
	 * Starting sign-in: pick how to get a client for this authorization server
	 * (our registered app, dynamic registration, or our metadata document).
	 */
	choose?: {
		clientMetadataUrl: string;
		fetchFn?: typeof fetch;
	};
	/** Where the owner's registered apps are configured; process.env by default. */
	env?: Record<string, string | undefined>;
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
		clientInformation: () =>
			record.app
				? (mcpOAuthAppCredentials(record.app, input.env) ?? undefined)
				: record.client,
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
		validateAuthorizationServerURL: async (_server, authorizationServer) => {
			if (new URL(authorizationServer).protocol !== "https:")
				throw new Error("MCP authorization servers must use HTTPS.");
			const choose = input.choose;
			if (
				!choose ||
				record.client ||
				(record.app && mcpOAuthAppCredentials(record.app, input.env))
			)
				return;
			record.app = undefined;
			const server = String(authorizationServer);
			const choice = chooseClientRegistration({
				authorizationServer: server,
				metadata: await fetchAuthorizationServerMetadata(
					server,
					choose.fetchFn,
				).catch(() => undefined),
				clientMetadataUrl: choose.clientMetadataUrl,
				env: input.env,
			});
			const hadUnavailable = record.unavailable !== undefined;
			record.unavailable = undefined;
			if (choice.kind === "app") record.app = choice.service;
			else if (choice.kind === "metadata-document") {
				record.client = choice.client;
				record.dynamic = false;
			} else if (choice.kind === "token") {
				record.unavailable = {
					reason: choice.reason,
					authorizationServer: server,
				};
				await save();
				throw new McpSignInUnavailable(choice.reason);
			}
			if (choice.kind !== "dynamic" || hadUnavailable) await save();
		},
		invalidateCredentials: async (scope) => {
			if (scope === "all" || scope === "client") {
				record.client = undefined;
				record.dynamic = undefined;
				record.app = undefined;
			}
			if (scope === "all" || scope === "tokens") record.tokens = undefined;
			await save();
		},
	};
	return provider;
}

const persistFor =
	(userId: string, serverId: string) => async (record: OAuthRecord) =>
		saveMcpOAuth(
			userId,
			serverId,
			await seal(JSON.stringify(record), { purpose: "mcp-oauth", userId }),
		);

/**
 * Starts sign-in: returns the provider's authorization URL, or null if already
 * signed in. Throws McpSignInUnavailable when the service cannot sign users in
 * (no registered app, dynamic registration or metadata document).
 */
export async function startMcpOAuth(input: {
	userId: string;
	serverId: string;
	appUrl: string;
	fetchFn?: typeof fetch;
	env?: Record<string, string | undefined>;
}) {
	const server = await mcpServerForOwner(input.userId, input.serverId);
	if (server?.auth !== "oauth") throw new Error("MCP server not found.");
	// Workers throw on the SDK's redirect: "error" (see workers-fetch.ts).
	const fetchFn = input.fetchFn ?? redirectRefusingFetch();
	const state = randomBytes(32).toString("base64url");
	const provider = storedOAuthProvider({
		record: await readOAuthRecord(server.sealedOAuth, input.userId),
		redirectUrl: mcpOAuthRedirectUrl(input.appUrl),
		persist: persistFor(input.userId, server.id),
		state,
		choose: {
			clientMetadataUrl: mcpClientMetadataUrl(input.appUrl),
			fetchFn,
		},
		env: input.env,
	});
	const result = await auth(provider, {
		serverUrl: server.url,
		fetchFn,
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
	env?: Record<string, string | undefined>;
}) {
	const pending = await takeMcpOAuthState(input.userId, input.state);
	if (!pending) throw new Error("Sign-in expired. Start again.");
	const server = await mcpServerForOwner(input.userId, pending.serverId);
	if (server?.auth !== "oauth") throw new Error("MCP server not found.");
	const provider = storedOAuthProvider({
		record: await readOAuthRecord(server.sealedOAuth, input.userId),
		redirectUrl: mcpOAuthRedirectUrl(input.appUrl),
		persist: persistFor(input.userId, server.id),
		verifier: pending.verifier,
		state: input.state,
		env: input.env,
	});
	const result = await auth(provider, {
		serverUrl: server.url,
		authorizationCode: input.code,
		callbackState: input.state,
		callbackIssuer: input.issuer,
		fetchFn: input.fetchFn ?? redirectRefusingFetch(),
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
		record: await readOAuthRecord(input.sealedOAuth, input.userId),
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
