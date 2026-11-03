import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { connectableMcpServers, listMcpServersWithOAuth } from "./mcp-servers";
import {
	enabledPluginComponents,
	listInstalls,
	pruneRemovedInstalls,
} from "./plugin-installs";

const holder = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./database", () => ({ database: () => holder }));

let db: PGlite;
const components = {
	skills: [],
	commands: [],
	mcpServers: [],
	unsupported: [],
	version: null,
	description: "",
};

beforeEach(async () => {
	db = new PGlite();
	await db.exec(`
	 create table plugin_install(id uuid primary key,user_id text not null,project_id uuid,catalog_id text not null,plugin_name text not null,commit_sha text not null,components jsonb not null,sealed_config text,enabled boolean not null default true,created_at timestamptz not null default now());
	 create table mcp_server(id uuid primary key,user_id text not null,project_id uuid,name text not null,url text not null,sealed_headers text,header_names text[] not null default '{}',plugin_id text,enabled boolean not null default true,auth text not null default 'headers',sealed_oauth text,created_at timestamptz not null default now(),updated_at timestamptz not null default now());`);
	holder.query.mockImplementation(async (sql: string, values: unknown[]) => {
		const result = await db.query(sql, values);
		return { ...result, rowCount: result.affectedRows || result.rows.length };
	});
});
afterEach(() => db.close());

async function install(userId: string, catalogId: string) {
	const id = randomUUID();
	await db.query(
		"insert into plugin_install(id,user_id,catalog_id,plugin_name,commit_sha,components) values($1,$2,$3,$3,$4,$5::jsonb)",
		[id, userId, catalogId, "a".repeat(40), JSON.stringify(components)],
	);
	return id;
}

async function server(userId: string, name: string, pluginId: string | null) {
	await db.query(
		"insert into mcp_server(id,user_id,name,url,plugin_id) values($1,$2,$3,$4,$5)",
		[randomUUID(), userId, name, `https://${name}.example.com/mcp`, pluginId],
	);
}

async function seed() {
	// slack was dropped from the catalog after these users installed it.
	await server("alice", "slack", await install("alice", "slack"));
	await server("alice", "linear", await install("alice", "linear"));
	await server("alice", "mine", null);
	await server("bob", "slack", await install("bob", "slack"));
}

it("turns skip installs and MCP servers of plugins removed from the catalog", async () => {
	await seed();
	expect(
		(await enabledPluginComponents("alice", null)).map((row) => row.plugin),
	).toEqual(["linear"]);
	expect(
		(await connectableMcpServers("alice", null)).map((row) => row.name),
	).toEqual(["linear", "mine"]);
});

it("prunes one user's removed installs with their servers, keeping their own servers", async () => {
	await seed();
	await pruneRemovedInstalls("alice");
	expect((await listInstalls("alice")).map((row) => row.catalogId)).toEqual([
		"linear",
	]);
	expect(
		(await listMcpServersWithOAuth("alice")).map((row) => row.server.name),
	).toEqual(["linear", "mine"]);
	// Other users are pruned only when they load their own settings.
	expect((await listInstalls("bob")).map((row) => row.catalogId)).toEqual([
		"slack",
	]);
});
