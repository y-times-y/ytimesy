import type { OAuthClientInformation } from "@ai-sdk/mcp";

/**
 * How we get an OAuth client for an MCP server's authorization server, in the
 * order the MCP authorization spec suggests and Claude Code, Cursor and VS Code
 * follow: our own registered app for that service, then dynamic client
 * registration (RFC 7591), then a Client ID Metadata Document. A server with
 * none of these (Slack, GitHub, Render) cannot sign a user in; the user pastes a
 * token instead.
 */

/**
 * Services whose authorization server has no dynamic registration, but where
 * the owner can register an OAuth app. Credentials come from
 * MCP_OAUTH_<service>_CLIENT_ID and MCP_OAUTH_<service>_CLIENT_SECRET.
 * Matched on the authorization server the MCP server names, so a custom server
 * that signs in with the same provider works too.
 */
export const MCP_OAUTH_APPS = [
	{
		service: "SLACK",
		name: "Slack",
		authorizationServers: ["https://mcp.slack.com"],
	},
	{
		service: "GITHUB",
		name: "GitHub",
		authorizationServers: ["https://github.com/login/oauth"],
	},
] as const;

export type McpOAuthApp = (typeof MCP_OAUTH_APPS)[number];

const sameServer = (a: string, b: string) =>
	a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

export function mcpOAuthAppFor(authorizationServer: string) {
	return MCP_OAUTH_APPS.find((app) =>
		app.authorizationServers.some((server) =>
			sameServer(server, authorizationServer),
		),
	);
}

/** The owner's registered app for a service, or null when not configured. */
export function mcpOAuthAppCredentials(
	service: string,
	env: Record<string, string | undefined> = process.env,
): OAuthClientInformation | null {
	const id = env[`MCP_OAUTH_${service}_CLIENT_ID`]?.trim();
	const secret = env[`MCP_OAUTH_${service}_CLIENT_SECRET`]?.trim();
	return id && secret ? { client_id: id, client_secret: secret } : null;
}

/** What we read from authorization server metadata (RFC 8414 / OIDC discovery). */
export type AuthorizationServerMetadata = {
	registration_endpoint?: string;
	client_id_metadata_document_supported?: boolean;
};

export type ClientRegistration =
	| { kind: "app"; service: string; client: OAuthClientInformation }
	| { kind: "dynamic" }
	| { kind: "metadata-document"; client: OAuthClientInformation }
	/** "setup": the owner can register an app for this service but has not. */
	| { kind: "token"; reason: "setup" | "token" };

export function chooseClientRegistration(input: {
	authorizationServer: string;
	/** Undefined when the server publishes none; the SDK then tries /register. */
	metadata: AuthorizationServerMetadata | undefined;
	/** Our Client ID Metadata Document URL; only an HTTPS URL can be a client id. */
	clientMetadataUrl: string;
	env?: Record<string, string | undefined>;
}): ClientRegistration {
	const app = mcpOAuthAppFor(input.authorizationServer);
	const client = app && mcpOAuthAppCredentials(app.service, input.env);
	if (app && client) return { kind: "app", service: app.service, client };
	if (!input.metadata || input.metadata.registration_endpoint)
		return { kind: "dynamic" };
	if (
		input.metadata.client_id_metadata_document_supported === true &&
		input.clientMetadataUrl.startsWith("https://")
	)
		return {
			kind: "metadata-document",
			client: { client_id: input.clientMetadataUrl },
		};
	return { kind: "token", reason: app ? "setup" : "token" };
}

/** Discovery URLs in the order the MCP spec gives (RFC 8414, then OIDC). */
export function authorizationServerMetadataUrls(authorizationServer: string) {
	const url = new URL(authorizationServer);
	const path = url.pathname.replace(/\/+$/, "");
	if (!path)
		return [
			`${url.origin}/.well-known/oauth-authorization-server`,
			`${url.origin}/.well-known/openid-configuration`,
		];
	return [
		`${url.origin}/.well-known/oauth-authorization-server${path}`,
		`${url.origin}/.well-known/openid-configuration${path}`,
		`${url.origin}${path}/.well-known/openid-configuration`,
	];
}

export async function fetchAuthorizationServerMetadata(
	authorizationServer: string,
	fetchFn: typeof fetch = fetch,
): Promise<AuthorizationServerMetadata | undefined> {
	for (const url of authorizationServerMetadataUrls(authorizationServer)) {
		const response = await fetchFn(url, {
			redirect: "manual",
			signal: AbortSignal.timeout(10_000),
			headers: { Accept: "application/json" },
		});
		if (!response.ok) {
			await response.body?.cancel();
			continue;
		}
		const body = (await response.json()) as Record<string, unknown>;
		return {
			registration_endpoint:
				typeof body.registration_endpoint === "string"
					? body.registration_endpoint
					: undefined,
			client_id_metadata_document_supported:
				body.client_id_metadata_document_supported === true,
		};
	}
	return undefined;
}

/** Why sign-in cannot start; the UI then asks for a token. */
export class McpSignInUnavailable extends Error {
	constructor(readonly reason: "setup" | "token") {
		super(
			reason === "setup"
				? "Sign-in for this service isn't set up yet."
				: "This service needs a token.",
		);
	}
}

export type McpSignInStart =
	| { url: string | null }
	| { url: null; needs: "token"; reason: "setup" | "token" }
	| { url: null; failed: true };

/**
 * What the user sees when sign-in cannot start. Never the SDK's own text:
 * a missing dynamic registration means "paste a token", anything else is a
 * short retry line.
 */
export function mcpSignInStartFailure(error: unknown): McpSignInStart {
	if (error instanceof McpSignInUnavailable)
		return { url: null, needs: "token", reason: error.reason };
	const message = error instanceof Error ? error.message : String(error);
	if (/dynamic client registration|registration_endpoint/i.test(message))
		return { url: null, needs: "token", reason: "token" };
	return { url: null, failed: true };
}
