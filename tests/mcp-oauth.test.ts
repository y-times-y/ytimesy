import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
	addMcpServer,
	connectableMcpServers,
	listMcpServers,
} from "../src/server/adapters/mcp-servers";
import {
	finishMcpOAuth,
	requiresOAuth,
	startMcpOAuth,
	turnOAuthProvider,
} from "../src/server/services/mcp-oauth";
import { mcpSignInState } from "../src/server/services/mcp-sign-in-status";
import { connectMcpTools } from "../src/server/services/mcp-tools";

let db: PGlite;
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({
		query: (sql: string, params: unknown[]) => db.query(sql, params),
	}),
}));
vi.mock("../src/server/config", () => ({
	serverConfig: () => ({
		BETTER_AUTH_SECRET: "fixture-secret-longer-than-thirty-two-characters",
	}),
}));

beforeAll(async () => {
	db = new PGlite();
	await db.exec(
		"create role anon; create role authenticated; create table auth_user(id text primary key); insert into auth_user values ('alice'); create table project(id uuid primary key);",
	);
	for (const file of [
		"20261011120000_mcp_servers.sql",
		"20261011150000_mcp_oauth.sql",
	])
		await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
});
afterAll(() => db.close());

const MCP = "https://mcp.example.com/mcp";
const AUTH = "https://auth.example.com";
const APP = "https://app.example.com";
const bearers: string[] = [];
let registered = 0;
/** The access token the MCP server currently honours; changing it revokes. */
let acceptedToken = "access-1";
let issued = 0;

/** A remote MCP server behind the MCP authorization spec, plus its OAuth server. */
const provider = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = new URL(String(input instanceof Request ? input.url : input));
	const body = String(init?.body ?? "");
	if (url.href === MCP) {
		const bearer = new Headers(init?.headers).get("authorization") ?? "";
		bearers.push(bearer);
		if (bearer !== `Bearer ${acceptedToken}`)
			return new Response(null, {
				status: 401,
				headers: {
					"WWW-Authenticate": `Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"`,
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
							protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
							capabilities: { tools: {} },
							serverInfo: { name: "linear", version: "1" },
						}
					: {
							tools: [
								{
									name: "list_issues",
									inputSchema: { type: "object", properties: {} },
								},
							],
						},
		});
	}
	if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
		return Response.json({ resource: MCP, authorization_servers: [AUTH] });
	if (url.href === `${AUTH}/.well-known/oauth-authorization-server`)
		return Response.json({
			issuer: AUTH,
			authorization_endpoint: `${AUTH}/authorize`,
			token_endpoint: `${AUTH}/token`,
			registration_endpoint: `${AUTH}/register`,
			response_types_supported: ["code"],
			code_challenge_methods_supported: ["S256"],
		});
	if (url.href === `${AUTH}/register`) {
		registered++;
		return Response.json({
			...JSON.parse(body),
			client_id: "client-1",
		});
	}
	if (url.href === `${AUTH}/token`) {
		const form = new URLSearchParams(body);
		if (
			form.get("grant_type") !== "authorization_code" ||
			form.get("code") !== "code-1" ||
			!form.get("code_verifier")
		)
			return Response.json({ error: "invalid_grant" }, { status: 400 });
		issued++;
		return Response.json({
			access_token: "access-1",
			token_type: "Bearer",
			refresh_token: "refresh-1",
			expires_in: 3600,
		});
	}
	return new Response("not found", { status: 404 });
}) as typeof fetch;

it("signs a user in to an OAuth MCP server and uses the tokens in turns", async () => {
	expect(await requiresOAuth(MCP, provider)).toBe(true);
	const server = await addMcpServer("alice", {
		name: "linear",
		url: MCP,
		auth: "oauth",
	});
	expect(server).toMatchObject({ auth: "oauth", signIn: "needs-sign-in" });
	const signInState = async () => {
		const [stored] = await connectableMcpServers("alice", null);
		return mcpSignInState({
			userId: "alice",
			serverId: stored.id,
			url: stored.url,
			sealedOAuth: stored.sealedOAuth,
			appUrl: APP,
			fetchFn: provider,
		});
	};

	const authorize = new URL(
		(await startMcpOAuth({
			userId: "alice",
			serverId: server.id,
			appUrl: APP,
			fetchFn: provider,
		})) as string,
	);
	expect(authorize.origin + authorize.pathname).toBe(`${AUTH}/authorize`);
	expect(authorize.searchParams.get("client_id")).toBe("client-1");
	expect(authorize.searchParams.get("redirect_uri")).toBe(
		`${APP}/api/mcp/oauth/callback`,
	);
	expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
	const state = authorize.searchParams.get("state") as string;
	expect(state.length).toBeGreaterThan(20);
	// Starting sign-in stores the registered client, but that is not a sign-in.
	expect(await signInState()).toBe("needs-sign-in");

	await finishMcpOAuth({
		userId: "alice",
		state,
		code: "code-1",
		appUrl: APP,
		fetchFn: provider,
	});
	expect(issued).toBe(1);
	expect(registered).toBe(1);
	// Listing without a check never claims a sign-in; the check connects for real.
	expect(await listMcpServers("alice")).toMatchObject([
		{ signIn: "needs-sign-in" },
	]);
	expect(await signInState()).toBe("signed-in");
	// The state is single-use.
	await expect(
		finishMcpOAuth({
			userId: "alice",
			state,
			code: "code-1",
			appUrl: APP,
			fetchFn: provider,
		}),
	).rejects.toThrow("Sign-in expired");

	const [stored] = await connectableMcpServers("alice", null);
	const mcp = await connectMcpTools(
		[
			{
				name: stored.name,
				url: stored.url,
				headers: stored.headers,
				authProvider: await turnOAuthProvider({
					userId: "alice",
					serverId: stored.id,
					sealedOAuth: stored.sealedOAuth,
					appUrl: APP,
				}),
			},
		],
		{ fetch: provider },
	);
	expect(mcp.unavailable).toEqual([]);
	expect(Object.keys(mcp.tools)).toEqual(["mcp__linear__list_issues"]);
	expect(bearers.at(-1)).toBe("Bearer access-1");
	await mcp.close();
	// Tokens are sealed at rest.
	const { rows } = await db.query<{ sealed_oauth: string }>(
		"select sealed_oauth from mcp_server",
	);
	expect(rows[0].sealed_oauth).not.toContain("access-1");
});

it("reports an OAuth server whose sign-in is missing as unavailable, without redirecting", async () => {
	const server = await addMcpServer("alice", {
		name: "sentry",
		url: MCP,
		auth: "oauth",
	});
	const mcp = await connectMcpTools(
		[
			{
				name: "sentry",
				url: MCP,
				headers: {},
				authProvider: await turnOAuthProvider({
					userId: "alice",
					serverId: server.id,
					sealedOAuth: null,
					appUrl: APP,
				}),
			},
		],
		{ fetch: provider },
	);
	expect(mcp.unavailable).toEqual(["sentry"]);
	await mcp.close();
});

it("reports a revoked sign-in and an unreachable server honestly", async () => {
	const [stored] = await connectableMcpServers("alice", null);
	const check = (fetchFn: typeof fetch) =>
		mcpSignInState({
			userId: "alice",
			serverId: stored.id,
			url: stored.url,
			sealedOAuth: stored.sealedOAuth,
			appUrl: APP,
			fetchFn,
		});
	const offline = (async () => {
		throw new TypeError("fetch failed");
	}) as typeof fetch;
	expect(await check(offline)).toBe("unreachable");
	// The server stops honouring the token and the refresh is refused.
	acceptedToken = "access-2";
	expect(await check(provider)).toBe("needs-sign-in");
	acceptedToken = "access-1";
});
