import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	connectableMcpServers,
	listMcpServersWithOAuth,
	saveMcpServerToken,
} from "./mcp-servers";
import {
	enabledPluginComponents,
	listInstalls,
	pruneRemovedInstalls,
} from "./plugin-installs";

const holder = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./database", () => ({ database: () => holder }));
vi.mock("#/server/auth/token-vault", () => ({
	seal: async (value: string, binding: { userId: string }) =>
		JSON.stringify({ value, userId: binding.userId }),
	unseal: async (sealed: string, binding: { userId: string }) => {
		const record = JSON.parse(sealed);
		if (record.userId !== binding.userId) throw new Error("Wrong owner.");
		return record.value;
	},
}));

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

it("inherits a saved account MCP token in new project and no-project turns, never another account", async () => {
	await server("alice", "private-api", null);
	const id = (await listMcpServersWithOAuth("alice"))[0].server.id;
	await saveMcpServerToken("alice", id, {
		Authorization: "Bearer synthetic-token",
	});
	for (const projectId of [null, randomUUID(), randomUUID()]) {
		expect(
			(await connectableMcpServers("alice", projectId))[0].headers,
		).toEqual({
			Authorization: "Bearer synthetic-token",
		});
		expect(await connectableMcpServers("bob", projectId)).toEqual([]);
	}
	await saveMcpServerToken("bob", id, {
		Authorization: "Bearer unrelated-token",
	});
	expect((await connectableMcpServers("alice", null))[0].headers).toEqual({
		Authorization: "Bearer synthetic-token",
	});
	expect(JSON.stringify(await listMcpServersWithOAuth("alice"))).not.toContain(
		"synthetic-token",
	);
});

it("uses a project MCP credential once per name and keeps account credentials in other projects", async () => {
	await server("alice", "shared-api", null);
	const account = (await listMcpServersWithOAuth("alice"))[0].server.id;
	await saveMcpServerToken("alice", account, {
		Authorization: "Bearer account-token",
	});
	const projectId = randomUUID();
	const projectServer = randomUUID();
	await db.query(
		"insert into mcp_server(id,user_id,project_id,name,url) values($1,'alice',$2,'shared-api','https://project.example/mcp')",
		[projectServer, projectId],
	);
	await saveMcpServerToken("alice", projectServer, {
		Authorization: "Bearer project-token",
	});
	const selected = await connectableMcpServers("alice", projectId);
	expect(selected).toHaveLength(1);
	expect(selected[0]).toMatchObject({
		id: projectServer,
		headers: { Authorization: "Bearer project-token" },
	});
	for (const otherProject of [null, randomUUID()])
		expect(
			(await connectableMcpServers("alice", otherProject))[0],
		).toMatchObject({
			id: account,
			headers: { Authorization: "Bearer account-token" },
		});
	await db.query("update mcp_server set enabled=false where id=$1", [
		projectServer,
	]);
	expect((await connectableMcpServers("alice", projectId))[0].id).toBe(account);
});

it("does not inherit servers from a disabled or differently scoped plugin install", async () => {
	const plugin = await install("alice", "linear");
	await server("alice", "linear", plugin);
	const projectId = randomUUID();
	await db.query("update plugin_install set project_id=$1 where id=$2", [
		projectId,
		plugin,
	]);
	expect(await connectableMcpServers("alice", null)).toEqual([]);
	expect(await connectableMcpServers("alice", randomUUID())).toEqual([]);
	expect(await connectableMcpServers("alice", projectId)).toHaveLength(1);
	await db.query("update plugin_install set enabled=false where id=$1", [
		plugin,
	]);
	expect(await connectableMcpServers("alice", projectId)).toEqual([]);
});

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
