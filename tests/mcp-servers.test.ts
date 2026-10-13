import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
	addMcpServer,
	connectableMcpServers,
	listMcpServersWithOAuth,
	removeMcpServer,
	setMcpServerEnabled,
} from "../src/server/adapters/mcp-servers";

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
		"create role anon; create role authenticated; create table auth_user(id text primary key); insert into auth_user values ('alice'),('bob'); create table project(id uuid primary key); insert into project values ('11111111-1111-4111-8111-111111111111');",
	);
	for (const file of ["20261011120000_mcp_servers", "20261011150000_mcp_oauth"])
		await db.exec(await readFile(`supabase/migrations/${file}.sql`, "utf8"));
});
afterAll(() => db.close());

it("seals headers, lists only header names, and unseals them only for the server-side connector", async () => {
	const saved = await addMcpServer("alice", {
		name: "linear",
		url: "https://mcp.linear.app/mcp",
		headers: { Authorization: "Bearer live-secret" },
	});
	expect(saved).toMatchObject({
		name: "linear",
		headerNames: ["Authorization"],
		enabled: true,
	});
	expect(
		JSON.stringify(
			(await listMcpServersWithOAuth("alice")).map((entry) => entry.server),
		),
	).not.toContain("live-secret");
	const stored = await db.query<{ sealed_headers: string }>(
		"select sealed_headers from mcp_server",
	);
	expect(stored.rows[0].sealed_headers).not.toContain("live-secret");
	expect(await connectableMcpServers("alice", null)).toMatchObject([
		{
			name: "linear",
			url: "https://mcp.linear.app/mcp",
			headers: { Authorization: "Bearer live-secret" },
		},
	]);
	expect(
		(await listMcpServersWithOAuth("bob")).map((entry) => entry.server),
	).toEqual([]);
	expect(await connectableMcpServers("bob", null)).toEqual([]);
});

it("scopes project servers, honours disable, and rejects non-HTTPS URLs", async () => {
	const project = "11111111-1111-4111-8111-111111111111";
	const scoped = await addMcpServer("alice", {
		name: "sentry",
		url: "https://mcp.sentry.dev/mcp",
		projectId: project,
	});
	expect(
		(await connectableMcpServers("alice", null)).map((s) => s.name),
	).toEqual(["linear"]);
	expect(
		(await connectableMcpServers("alice", project)).map((s) => s.name),
	).toEqual(["linear", "sentry"]);
	await setMcpServerEnabled("alice", scoped.id, false);
	expect(
		(await connectableMcpServers("alice", project)).map((s) => s.name),
	).toEqual(["linear"]);
	await removeMcpServer("alice", scoped.id);
	expect(
		(await listMcpServersWithOAuth("alice"))
			.map((entry) => entry.server)
			.map((s) => s.name),
	).toEqual(["linear"]);
	await expect(
		addMcpServer("alice", { name: "plain", url: "http://example.com/mcp" }),
	).rejects.toThrow();
});
