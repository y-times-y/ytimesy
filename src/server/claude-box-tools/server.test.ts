import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boxCallRunsOnEdge } from "#/domain/claude-box-tools";
import type { GuestExec } from "./identity-machines";
import {
	type ClaudeBoxToolsConfig,
	type ClaudeBoxToolsServer,
	startClaudeBoxTools,
} from "./server";

const SESSION = "11111111-1111-4111-8111-111111111111";
const TURN = "22222222-2222-4222-8222-222222222222";
const EDGE = "https://edge.example/claude/mcp";

/** The chat's VM, played by this machine's shell: the tools' real commands run here. */
const localExec: GuestExec = (options) =>
	new Promise((resolve) => {
		const child = execFile(
			"bash",
			["-c", options.command],
			{ timeout: options.timeoutMs, maxBuffer: 64 * 1024 * 1024 },
			(error, stdout, stderr) =>
				resolve({
					stdout,
					stderr,
					statusCode:
						error && typeof error.code === "number"
							? error.code
							: error
								? null
								: 0,
				}),
		);
		child.stdin?.end(
			options.stdin === undefined
				? undefined
				: Buffer.from(options.stdin, "base64"),
		);
	});

/** The edge's MCP route: lists ytimesy's tools and answers forwarded calls. */
function fakeEdge() {
	const calls: { method: string; params: unknown; authorization: string }[] =
		[];
	const fetcher = vi.fn(
		async (url: string | URL | Request, init?: RequestInit) => {
			expect(String(url)).toBe(EDGE);
			const body = JSON.parse(String(init?.body));
			calls.push({
				method: body.method,
				params: body.params,
				authorization: new Headers(init?.headers).get("authorization") ?? "",
			});
			const result =
				body.method === "tools/list"
					? {
							tools: ["bash", "read", "write", "edit", "canvas"].map(
								(name) => ({
									name,
									description: name,
									inputSchema: { type: "object" },
								}),
							),
						}
					: {
							content: [{ type: "text", text: `edge ran ${body.params.name}` }],
							isError: false,
						};
			return Response.json({ jsonrpc: "2.0", id: body.id, result });
		},
	);
	return { calls, fetcher: fetcher as unknown as typeof fetch };
}

const started: ClaudeBoxToolsServer[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const server of started.splice(0)) await server.close();
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

async function start(
	overrides: Partial<ClaudeBoxToolsConfig> = {},
	exec: GuestExec = localExec,
) {
	const cwd = mkdtempSync(join(tmpdir(), "box-tools-repo-"));
	directories.push(cwd);
	const edge = fakeEdge();
	const server = await startClaudeBoxTools({
		config: {
			token: "fs-identity-token",
			vmId: "vm-1",
			linuxUser: "ubuntu",
			cwd,
			sessionId: SESSION,
			turnId: TURN,
			shape: "core",
			tools: ["bash", "read", "write", "edit"],
			redact: ["ghs_turn_git_token"],
			...overrides,
		},
		edge: { url: EDGE, headers: { Authorization: "Bearer edge-grant" } },
		exec,
		fetch: edge.fetcher,
	});
	started.push(server);
	const rpc = async (
		method: string,
		params: unknown = {},
		headers = server.headers,
	) => {
		const response = await fetch(server.url, {
			method: "POST",
			headers: { ...headers, "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }),
		});
		return {
			status: response.status,
			body: response.status === 200 ? await response.json() : null,
		};
	};
	const call = async (name: string, args: Record<string, unknown>) =>
		(await rpc("tools/call", { name, arguments: args })).body.result as {
			content: { type: string; text: string }[];
			isError: boolean;
		};
	return { cwd, edge, server, rpc, call };
}

describe("the runner box's tool server", () => {
	it("runs the lean file tools itself against the VM, and lists the edge's tools", async () => {
		const box = await start();
		expect([...box.server.local].sort()).toEqual([
			"bash",
			"edit",
			"read",
			"write",
		]);
		const listed = await box.rpc("tools/list");
		expect(
			listed.body.result.tools.map((tool: { name: string }) => tool.name),
		).toEqual(["bash", "read", "write", "edit", "canvas"]);
		const written = await box.call("write", {
			path: "notes.txt",
			content: "hello box\n",
		});
		expect(written.isError).toBe(false);
		expect(readFileSync(join(box.cwd, "notes.txt"), "utf8")).toBe(
			"hello box\n",
		);
		const read = await box.call("read", { path: "notes.txt" });
		expect(read.content[0]?.text).toContain("hello box");
		const edited = await box.call("edit", {
			path: "notes.txt",
			edits: [{ old_string: "hello", new_string: "goodbye" }],
		});
		expect(edited.isError).toBe(false);
		expect(readFileSync(join(box.cwd, "notes.txt"), "utf8")).toBe(
			"goodbye box\n",
		);
		// A foreground command through the runtime's tracked command runner.
		const ran = await box.call("bash", { command: "cat notes.txt && pwd" });
		expect(ran.isError).toBe(false);
		expect(ran.content[0]?.text).toContain("goodbye box");
		expect(ran.content[0]?.text).toContain(box.cwd);
		// Only the list went to the edge: no workspace call woke the chat's object.
		expect(box.edge.calls.map((call) => call.method)).toEqual(["tools/list"]);
		expect(box.edge.calls[0]?.authorization).toBe("Bearer edge-grant");
	});

	it("sends the tools it does not serve, background starts and ytimesy-browser to the edge", async () => {
		const box = await start();
		expect((await box.call("canvas", { title: "x" })).content[0]?.text).toBe(
			"edge ran canvas",
		);
		expect(
			(await box.call("bash", { command: "npm run dev", background: true }))
				.content[0]?.text,
		).toBe("edge ran bash");
		expect(
			(await box.call("bash", { command: "ytimesy-browser screenshot" }))
				.content[0]?.text,
		).toBe("edge ran bash");
		expect(
			box.edge.calls
				.filter((call) => call.method === "tools/call")
				.map((call) => call.params),
		).toEqual([
			{ name: "canvas", arguments: { title: "x" } },
			{ name: "bash", arguments: { command: "npm run dev", background: true } },
			{ name: "bash", arguments: { command: "ytimesy-browser screenshot" } },
		]);
	});

	it("hands a call to the edge when the provider refused it before anything ran", async () => {
		const refusing: GuestExec = async () => {
			throw Object.assign(new Error("vm paused"), { status: 409 });
		};
		const box = await start({}, refusing);
		expect((await box.call("read", { path: "a.txt" })).content[0]?.text).toBe(
			"edge ran read",
		);
	});

	it("reports an unknown outcome instead of running a call twice", async () => {
		const failing: GuestExec = async () => {
			throw Object.assign(new Error("socket hang up"), { status: 502 });
		};
		const box = await start({}, failing);
		const result = await box.call("read", { path: "a.txt" });
		expect(result.isError).toBe(true);
		expect(
			box.edge.calls.filter((call) => call.method === "tools/call"),
		).toEqual([]);
	});

	it("removes the turn's VM tokens from what it returns", async () => {
		const box = await start();
		writeFileSync(join(box.cwd, "creds"), "token=ghs_turn_git_token\n");
		const read = await box.call("read", { path: "creds" });
		expect(JSON.stringify(read)).not.toContain("ghs_turn_git_token");
	});

	it("answers only Claude Code, which holds its random bearer", async () => {
		const box = await start();
		expect((await box.rpc("tools/list", {}, {})).status).toBe(401);
		expect(
			(
				await box.rpc(
					"tools/list",
					{},
					{ Authorization: "Bearer fs-identity-token" },
				)
			).status,
		).toBe(401);
		expect(box.server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
	});
});

describe("which box tool calls go to the edge", () => {
	it("is background starts in every lean shape and ytimesy-browser or ytimesy-job commands", () => {
		expect(boxCallRunsOnEdge({ command: "ls", run_in_background: true })).toBe(
			true,
		);
		expect(boxCallRunsOnEdge({ cmd: "ls", background: true })).toBe(true);
		expect(boxCallRunsOnEdge({ command: "ls", is_background: true })).toBe(
			true,
		);
		expect(boxCallRunsOnEdge({ command: "ytimesy-job wait 1" })).toBe(true);
		expect(boxCallRunsOnEdge({ command: "ls -la", background: false })).toBe(
			false,
		);
		expect(boxCallRunsOnEdge({ path: "src/a.ts" })).toBe(false);
		expect(boxCallRunsOnEdge(null)).toBe(false);
	});
});
