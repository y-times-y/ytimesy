// biome-ignore-all lint/suspicious/noTemplateCurlyInString: plugin configs use literal ${user_config.KEY} placeholders.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
	connectableMcpServers,
	listMcpServers,
} from "../src/server/adapters/mcp-servers";
import {
	enabledPluginComponents,
	listInstalls,
	removeInstall,
	setInstallEnabled,
} from "../src/server/adapters/plugin-installs";
import { installCatalogPlugin } from "../src/server/services/plugin-install";

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

const sha = "0123456789abcdef0123456789abcdef01234567";
const entry = {
	id: "linear-tools",
	displayName: "Linear Tools",
	description: "Linear issues",
	owner: "acme",
	repo: "plugins",
	sha,
	path: "linear",
};
let archive: Buffer;

beforeAll(async () => {
	db = new PGlite();
	await db.exec(
		"create role anon; create role authenticated; create table auth_user(id text primary key); insert into auth_user values ('alice'); create table project(id uuid primary key);",
	);
	for (const file of [
		"20261011120000_mcp_servers.sql",
		"20261011130000_plugin_installs.sql",
	])
		await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
	const root = await mkdtemp(join(tmpdir(), "ytimesy-install-"));
	const files: Record<string, string> = {
		"linear/.claude-plugin/plugin.json": JSON.stringify({
			name: "linear-tools",
			userConfig: {
				api_token: {
					type: "string",
					title: "API token",
					description: "Key",
					sensitive: true,
					required: true,
				},
			},
		}),
		"linear/commands/standup.md":
			"---\ndescription: Standup\n---\nSummarize $ARGUMENTS.",
		"linear/skills/triage/SKILL.md":
			"---\nname: triage\ndescription: Triage\n---\nLabel and assign.",
		"linear/.mcp.json": JSON.stringify({
			mcpServers: {
				api: {
					type: "http",
					url: "https://mcp.example.com/mcp",
					headers: { Authorization: "Bearer ${user_config.api_token}" },
				},
				local: { command: "node" },
			},
		}),
	};
	for (const [path, text] of Object.entries(files)) {
		await mkdir(dirname(join(root, `acme-plugins-x/${path}`)), {
			recursive: true,
		});
		await writeFile(join(root, `acme-plugins-x/${path}`), text);
	}
	execFileSync("tar", [
		"-czf",
		join(root, "a.tgz"),
		"-C",
		root,
		"acme-plugins-x",
	]);
	archive = await readFile(join(root, "a.tgz"));
	await rm(root, { recursive: true, force: true });
});
afterAll(() => db.close());

const seen: string[] = [];
// Stand-in MCP endpoint: answers initialize / tools/list over JSON-RPC.
const mcpFetch = (async (_input: unknown, init?: RequestInit) => {
	seen.push(new Headers(init?.headers).get("authorization") ?? "");
	const message = JSON.parse(String(init?.body ?? "{}")) as {
		id?: number;
		method: string;
		params?: { protocolVersion?: string };
	};
	if (message.id === undefined) return new Response(null, { status: 202 });
	const result =
		message.method === "initialize"
			? {
					protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
					capabilities: { tools: {} },
					serverInfo: { name: "s", version: "1" },
				}
			: message.method === "tools/list"
				? { tools: [] }
				: null;
	return Response.json(
		result
			? { jsonrpc: "2.0", id: message.id, result }
			: {
					jsonrpc: "2.0",
					id: message.id,
					error: { code: -32601, message: "no" },
				},
	);
}) as typeof fetch;

it("installs only catalog plugins, requires their settings, and registers their HTTP MCP servers sealed", async () => {
	const base = {
		userId: "alice",
		catalogId: "linear-tools",
		projectId: null,
		catalog: [entry],
		fetch: (async () => new Response(new Uint8Array(archive))) as typeof fetch,
		mcpFetch,
	};
	await expect(
		installCatalogPlugin({ ...base, catalogId: "unreviewed", config: {} }),
	).rejects.toThrow("reviewed catalog");
	await expect(installCatalogPlugin({ ...base, config: {} })).rejects.toThrow(
		"API token",
	);
	const installed = await installCatalogPlugin({
		...base,
		config: { api_token: "tok-123" },
	});
	expect(installed.unsupported.join(" ")).toMatch(/local/);
	expect(seen.every((value) => value === "Bearer tok-123")).toBe(true);
	const [install] = await listInstalls("alice");
	expect(install).toMatchObject({
		pluginName: "linear-tools",
		commitSha: sha,
		commands: ["standup"],
		skills: ["triage"],
		mcpServers: ["linear-tools-api"],
	});
	const [server] = await listMcpServers("alice");
	expect(server).toMatchObject({
		name: "linear-tools-api",
		pluginId: installed.id,
		headerNames: ["Authorization"],
	});
	expect(JSON.stringify(await listMcpServers("alice"))).not.toContain(
		"tok-123",
	);
	expect((await connectableMcpServers("alice", null))[0].headers).toEqual({
		Authorization: "Bearer tok-123",
	});
	expect(
		(await enabledPluginComponents("alice", null))[0].commands[0].name,
	).toBe("standup");

	await setInstallEnabled("alice", installed.id, false);
	expect(await enabledPluginComponents("alice", null)).toEqual([]);
	expect(await connectableMcpServers("alice", null)).toEqual([]);
	await removeInstall("alice", installed.id);
	expect(await listInstalls("alice")).toEqual([]);
	expect(await listMcpServers("alice")).toEqual([]);
});

it("installs a sign-in (OAuth) plugin with its commands and marks its MCP server as needing sign-in", async () => {
	const root = await mkdtemp(join(tmpdir(), "ytimesy-oauth-"));
	const files: Record<string, string> = {
		"p/.claude-plugin/plugin.json": JSON.stringify({ name: "Linear" }),
		"p/commands/triage.md": "Triage my issues.",
		"p/.mcp.json": JSON.stringify({
			linear: { type: "http", url: "https://mcp.linear.app/mcp" },
		}),
	};
	for (const [path, text] of Object.entries(files)) {
		await mkdir(dirname(join(root, `acme-p-x/${path}`)), { recursive: true });
		await writeFile(join(root, `acme-p-x/${path}`), text);
	}
	execFileSync("tar", ["-czf", join(root, "a.tgz"), "-C", root, "acme-p-x"]);
	const bytes = new Uint8Array(await readFile(join(root, "a.tgz")));
	await rm(root, { recursive: true, force: true });
	const installed = await installCatalogPlugin({
		userId: "alice",
		catalogId: "linear",
		projectId: null,
		config: {},
		catalog: [{ ...entry, id: "linear", path: "p" }],
		fetch: (async () => new Response(bytes)) as typeof fetch,
		mcpFetch: (async () => new Response(null, { status: 401 })) as typeof fetch,
	});
	expect(installed.unsupported.join(" ")).toContain(
		"linear-linear needs sign-in",
	);
	const [install] = await listInstalls("alice");
	expect(install).toMatchObject({
		pluginName: "linear",
		commands: ["triage"],
		mcpServers: [],
	});
	expect(await listMcpServers("alice")).toEqual([]);
	await removeInstall("alice", installed.id);
});
