import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
	addMcpServer,
	connectableMcpServers,
	saveMcpServerToken,
} from "../src/server/adapters/mcp-servers";
import {
	finishMcpOAuth,
	mcpClientMetadataDocument,
	startMcpOAuth,
} from "../src/server/services/mcp-oauth";
import { McpSignInUnavailable } from "../src/server/services/mcp-oauth-client";
import { mcpSignInState } from "../src/server/services/mcp-sign-in-status";

let db: PGlite;
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({
		query: (sql: string, params: unknown[]) => db.query(sql, params),
	}),
}));
vi.mock("../src/server/config", () => {
	const serverConfig = () => ({
		BETTER_AUTH_SECRET: "fixture-secret-longer-than-thirty-two-characters",
	});
	return {
		serverConfig,
		databaseConfig: serverConfig,
		vaultConfig: serverConfig,
	};
});

beforeAll(async () => {
	db = new PGlite();
	await db.exec(
		"create role anon; create role authenticated; create table auth_user(id text primary key); insert into auth_user values ('alice'); create table project(id uuid primary key);",
	);
	for (const file of [
		"20261011120000_mcp_servers.sql",
		"20261011130000_plugin_installs.sql",
		"20261011150000_mcp_oauth.sql",
	])
		await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
});
afterAll(() => db.close());

const APP = "https://app.example.com";
const slackApp = {
	MCP_OAUTH_SLACK_CLIENT_ID: "123.456",
	MCP_OAUTH_SLACK_CLIENT_SECRET: "app-secret",
};

/**
 * An MCP server whose authorization server has no registration endpoint, like
 * Slack's (mcp.slack.com, client_secret_post) or one that accepts Client ID
 * Metadata Documents. Records each token request.
 */
function service(input: {
	mcp: string;
	authServer: string;
	cimd?: boolean;
	acceptedBearer: string;
}) {
	const tokenRequests: URLSearchParams[] = [];
	const fetchFn = (async (request: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(
			String(request instanceof Request ? request.url : request),
		);
		const body = String(init?.body ?? "");
		if (url.href === input.mcp) {
			const bearer = new Headers(init?.headers).get("authorization");
			if (bearer !== input.acceptedBearer)
				return new Response(null, {
					status: 401,
					headers: {
						"WWW-Authenticate": `Bearer resource_metadata="${new URL(input.mcp).origin}/.well-known/oauth-protected-resource"`,
					},
				});
			const message = JSON.parse(body || "{}") as {
				id?: number;
				method: string;
				params?: { protocolVersion?: string };
			};
			if (message.id === undefined) return new Response(null, { status: 202 });
			return Response.json({
				jsonrpc: "2.0",
				id: message.id,
				result:
					message.method === "initialize"
						? {
								protocolVersion:
									message.params?.protocolVersion ?? "2025-06-18",
								capabilities: { tools: {} },
								serverInfo: { name: "s", version: "1" },
							}
						: { tools: [] },
			});
		}
		if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
			return Response.json({
				resource: input.mcp,
				authorization_servers: [input.authServer],
			});
		if (
			url.href === `${input.authServer}/.well-known/oauth-authorization-server`
		)
			return Response.json({
				issuer: input.authServer,
				authorization_endpoint: `${input.authServer}/authorize`,
				token_endpoint: `${input.authServer}/token`,
				response_types_supported: ["code"],
				code_challenge_methods_supported: ["S256"],
				token_endpoint_auth_methods_supported: input.cimd
					? ["none"]
					: ["client_secret_post"],
				...(input.cimd ? { client_id_metadata_document_supported: true } : {}),
			});
		if (url.href === `${input.authServer}/token`) {
			const form = new URLSearchParams(body);
			tokenRequests.push(form);
			return Response.json({
				access_token: "user-token",
				token_type: "Bearer",
				expires_in: 3600,
			});
		}
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
	return { fetchFn, tokenRequests };
}

const signInState = async (serverId: string, fetchFn: typeof fetch) => {
	const stored = (await connectableMcpServers("alice", null)).find(
		(server) => server.id === serverId,
	);
	if (!stored) throw new Error("missing");
	return mcpSignInState({
		userId: "alice",
		serverId,
		url: stored.url,
		sealedOAuth: stored.sealedOAuth,
		appUrl: APP,
		fetchFn,
	});
};

it("Slack without the owner's app: asks for a token; with it: signs in with the app's client id and secret", async () => {
	const slack = service({
		mcp: "https://mcp.slack.com/mcp",
		authServer: "https://mcp.slack.com",
		acceptedBearer: "Bearer user-token",
	});
	const server = await addMcpServer("alice", {
		name: "slack",
		url: "https://mcp.slack.com/mcp",
		auth: "oauth",
	});
	const start = (env: Record<string, string>) =>
		startMcpOAuth({
			userId: "alice",
			serverId: server.id,
			appUrl: APP,
			fetchFn: slack.fetchFn,
			env,
		});

	const unavailable = await start({}).catch((error) => error);
	expect(unavailable).toBeInstanceOf(McpSignInUnavailable);
	expect(unavailable.reason).toBe("setup");
	expect(unavailable.message).not.toMatch(/dynamic client registration/);
	expect(await signInState(server.id, slack.fetchFn)).toBe("needs-token");

	const authorize = new URL((await start(slackApp)) as string);
	expect(authorize.origin + authorize.pathname).toBe(
		"https://mcp.slack.com/authorize",
	);
	expect(authorize.searchParams.get("client_id")).toBe("123.456");
	expect(authorize.searchParams.get("redirect_uri")).toBe(
		`${APP}/api/mcp/oauth/callback`,
	);
	await finishMcpOAuth({
		userId: "alice",
		state: authorize.searchParams.get("state") as string,
		code: "code-1",
		appUrl: APP,
		fetchFn: slack.fetchFn,
		env: slackApp,
	});
	const [exchange] = slack.tokenRequests;
	expect(exchange.get("client_id")).toBe("123.456");
	expect(exchange.get("client_secret")).toBe("app-secret");
	expect(await signInState(server.id, slack.fetchFn)).toBe("signed-in");
	// The app's secret is read from settings, never stored with the user's sign-in.
	const { rows } = await db.query<{ sealed_oauth: string }>(
		"select sealed_oauth from mcp_server where id=$1",
		[server.id],
	);
	expect(rows[0].sealed_oauth).not.toContain("app-secret");
});

it("uses our Client ID Metadata Document where the server accepts one", async () => {
	const cimd = service({
		mcp: "https://mcp.cimd.example/mcp",
		authServer: "https://auth.cimd.example",
		cimd: true,
		acceptedBearer: "Bearer user-token",
	});
	const server = await addMcpServer("alice", {
		name: "cimd",
		url: "https://mcp.cimd.example/mcp",
		auth: "oauth",
	});
	const authorize = new URL(
		(await startMcpOAuth({
			userId: "alice",
			serverId: server.id,
			appUrl: APP,
			fetchFn: cimd.fetchFn,
		})) as string,
	);
	const clientId = authorize.searchParams.get("client_id");
	expect(clientId).toBe(`${APP}/api/mcp/oauth/client-metadata`);
	expect(mcpClientMetadataDocument(APP)).toMatchObject({
		client_id: clientId,
		redirect_uris: [`${APP}/api/mcp/oauth/callback`],
		token_endpoint_auth_method: "none",
	});
});

it("a server nobody can register with takes the user's token instead, sealed", async () => {
	const render = service({
		mcp: "https://mcp.render.example/mcp",
		authServer: "https://api.render.example",
		acceptedBearer: "Bearer rnd_key",
	});
	const server = await addMcpServer("alice", {
		name: "render",
		url: "https://mcp.render.example/mcp",
		auth: "oauth",
	});
	const unavailable = await startMcpOAuth({
		userId: "alice",
		serverId: server.id,
		appUrl: APP,
		fetchFn: render.fetchFn,
	}).catch((error) => error);
	expect(unavailable).toMatchObject({ reason: "token" });
	expect(await signInState(server.id, render.fetchFn)).toBe("needs-token");

	await saveMcpServerToken("alice", server.id, {
		Authorization: "Bearer rnd_key",
	});
	const stored = (await connectableMcpServers("alice", null)).find(
		(row) => row.id === server.id,
	);
	expect(stored).toMatchObject({
		auth: "headers",
		sealedOAuth: null,
		headers: { Authorization: "Bearer rnd_key" },
	});
	const { rows } = await db.query<{ sealed_headers: string }>(
		"select sealed_headers from mcp_server where id=$1",
		[server.id],
	);
	expect(rows[0].sealed_headers).not.toContain("rnd_key");
});
