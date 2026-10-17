import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asSchema, type ToolSet, tool } from "ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
	harnessModelToolInstructions,
	isShellSurface,
	type LeanToolShape,
	leanSurfaceShape,
	leanToolShape,
} from "#/domain/harness-model-profile";
import { WorkspaceId } from "#/domain/ids";
import { agentOutputDirectory } from "./agent-output-artifacts";
import { builderToolSurface } from "./builder-shell-surface";
import { type LeanCommandResult, leanShapeTools } from "./lean-tools";
import type { WorkspaceMachines } from "./workspace-machines";

let root: string;
let repo: string;
const sessionId = randomUUID();
const outputs = agentOutputDirectory(sessionId);

function sh(command: string) {
	return new Promise<{ exitCode: number; stdout: string; stderr: string }>(
		(done) =>
			execFile(
				"bash",
				["-c", command],
				{
					cwd: repo,
					env: { ...process.env, HOME: join(root, "home") },
					maxBuffer: 64 * 1024 * 1024,
				},
				(error, stdout, stderr) =>
					done({
						exitCode:
							error && typeof error.code === "number"
								? error.code
								: error
									? 1
									: 0,
						stdout,
						stderr,
					}),
			),
	);
}

const machines = {
	exec: (_vm: unknown, command: string) => sh(command),
	writeTextFile: (_vm: unknown, path: string, contents: string) =>
		writeFile(path, contents),
	readTextFile: async () => null,
} as unknown as WorkspaceMachines;

type Call = { tool: string; args: Record<string, unknown> };

/** The runtime's command tools, scripted: each call returns the next page. */
function commandRunner(pages: Record<string, Record<string, unknown>[]>) {
	const calls: Call[] = [];
	const fake = (name: string) =>
		tool({
			inputSchema: z.object({}).passthrough(),
			execute: async (args: Record<string, unknown>) => {
				calls.push({ tool: name, args });
				const next = pages[name]?.shift();
				if (!next) throw new Error(`unexpected ${name}`);
				return next;
			},
		});
	const tools: ToolSet = {
		execute_command: fake("execute_command"),
		continue_command: fake("continue_command"),
		stop_command: fake("stop_command"),
		report_task_blocked: fake("report_task_blocked"),
	};
	return { tools, calls };
}

function lean(shape: LeanToolShape, base: ToolSet = commandRunner({}).tools) {
	return leanShapeTools(shape, base, {
		workspace: async () => ({ machines, vm: WorkspaceId("vm"), cwd: repo }),
		sessionId,
		turnId: "turn",
		signal: new AbortController().signal,
		once: (_id, _fingerprint, run) => run(),
		installHelpers: async () => {},
	}).tools;
}

const options = { toolCallId: "call-1", messages: [] } as never;
const run = (tools: ToolSet, name: string, args: unknown) =>
	tools[name].execute?.(args as never, options) as Promise<unknown>;
const modelText = async (
	tools: ToolSet,
	name: string,
	args: unknown,
	output: unknown,
) => {
	const result = await tools[name].toModelOutput?.({
		toolCallId: "call-1",
		input: args as never,
		output,
	});
	return (result as { value: string }).value;
};

async function schemaOf(tools: ToolSet, name: string) {
	const schema = (await asSchema(tools[name].inputSchema).jsonSchema) as {
		properties: Record<string, unknown>;
		required?: string[];
	};
	return {
		properties: Object.keys(schema.properties),
		required: schema.required ?? [],
	};
}

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "lean-tools-"));
	repo = join(root, "repo");
	await mkdir(join(repo, "src"), { recursive: true });
	await mkdir(join(root, "home"));
	await mkdir(outputs, { recursive: true });
});
afterAll(async () => {
	await rm(root, { recursive: true, force: true });
	await rm(outputs, { recursive: true, force: true });
});

describe("model family to shape", () => {
	it.each([
		["gpt-6.1-sol", "codex"],
		["openai/gpt-6-luna", "codex"],
		["anthropic/claude-opus-5.5", "claude"],
		["claude-sonnet-5-5", "claude"],
		["moonshotai/kimi-k3", "claude"],
		["x-ai/grok-4.7", "claude"],
		["deepseek/deepseek-v4.1-flash", "claude"],
		["z-ai/glm-5.3", "claude"],
		["meta/muse-spark-1.3", "claude"],
		["someone/unknown-model", "claude"],
		["google/gemini-4-argon", "gemini"],
		["gemini-3.8-flash", "gemini"],
		["qwen/qwen3.8-max-prime", "qwen"],
	] as const)("%s uses the %s tools", (modelId, shape) => {
		expect(leanToolShape("lean-native", modelId)).toBe(shape);
		expect(leanToolShape("lean", modelId)).toBe("core");
	});
});

describe("each family's tool names and argument shapes", () => {
	it("Codex: exec_command, write_stdin, apply_patch ({input} off Responses), view_image", async () => {
		const base = commandRunner({}).tools;
		base.apply_patch = tool({
			inputSchema: z.object({ patch: z.string() }),
			execute: async (args) => ({ applied: args }),
		});
		const tools = lean("codex", base);
		expect(Object.keys(tools)).toEqual([
			"exec_command",
			"write_stdin",
			"apply_patch",
			"view_image",
		]);
		expect(await schemaOf(tools, "exec_command")).toEqual({
			properties: ["cmd", "workdir", "yield_time_ms", "max_output_tokens"],
			required: ["cmd"],
		});
		expect(await schemaOf(tools, "write_stdin")).toEqual({
			properties: ["session_id", "chars", "yield_time_ms", "max_output_tokens"],
			required: ["session_id"],
		});
		expect(await schemaOf(tools, "apply_patch")).toEqual({
			properties: ["input"],
			required: ["input"],
		});
		// The JSON fallback hands the patch text to the shared patch engine.
		expect(
			await run(tools, "apply_patch", {
				input: "*** Begin Patch\n*** End Patch",
			}),
		).toEqual({ applied: { patch: "*** Begin Patch\n*** End Patch" } });
		expect(await schemaOf(tools, "view_image")).toEqual({
			properties: ["path"],
			required: ["path"],
		});
	});

	it("Codex on a Responses route keeps the freeform apply_patch's definition", async () => {
		const base = commandRunner({}).tools;
		const freeform = {
			...tool({ inputSchema: z.object({}) }),
			id: "openai.custom",
			execute: async (patch: string) => patch,
		};
		base.apply_patch = freeform as never;
		const offered = lean("codex", base).apply_patch as typeof freeform;
		expect(offered.id).toBe("openai.custom");
		expect(offered.inputSchema).toBe(freeform.inputSchema);
		const patch = "*** Begin Patch\n*** Add File: a.py\n+x\n*** End Patch";
		expect(await offered.execute(patch)).toBe(patch);
	});

	it("Claude Code: Bash, Read, Write, Edit, Glob, Grep", async () => {
		const tools = lean("claude");
		expect(Object.keys(tools)).toEqual([
			"Bash",
			"Read",
			"Write",
			"Edit",
			"Glob",
			"Grep",
		]);
		expect(await schemaOf(tools, "Bash")).toEqual({
			properties: ["command", "timeout", "description", "run_in_background"],
			required: ["command"],
		});
		expect(await schemaOf(tools, "Read")).toEqual({
			properties: ["file_path", "offset", "limit"],
			required: ["file_path"],
		});
		expect(await schemaOf(tools, "Write")).toEqual({
			properties: ["file_path", "content"],
			required: ["file_path", "content"],
		});
		expect(await schemaOf(tools, "Edit")).toEqual({
			properties: ["file_path", "old_string", "new_string", "replace_all"],
			required: ["file_path", "old_string", "new_string"],
		});
		expect((await schemaOf(tools, "Grep")).properties).toEqual([
			"pattern",
			"path",
			"glob",
			"output_mode",
			"-i",
			"-C",
			"head_limit",
		]);
	});

	it("Gemini CLI: run_shell_command, read_file, write_file, replace, glob, grep_search", async () => {
		const tools = lean("gemini");
		expect(Object.keys(tools)).toEqual([
			"run_shell_command",
			"read_file",
			"write_file",
			"replace",
			"glob",
			"grep_search",
		]);
		expect(await schemaOf(tools, "run_shell_command")).toEqual({
			properties: ["command", "description", "dir_path", "is_background"],
			required: ["command"],
		});
		expect(await schemaOf(tools, "read_file")).toEqual({
			properties: ["file_path", "start_line", "end_line"],
			required: ["file_path"],
		});
		expect(await schemaOf(tools, "replace")).toEqual({
			properties: ["file_path", "old_string", "new_string", "allow_multiple"],
			required: ["file_path", "old_string", "new_string"],
		});
		expect(await schemaOf(tools, "grep_search")).toEqual({
			properties: ["pattern", "dir_path", "include"],
			required: ["pattern"],
		});
	});

	it("Qwen Code: the Gemini shape with edit{replace_all} instead of replace", async () => {
		const tools = lean("qwen");
		expect(Object.keys(tools)).toEqual([
			"run_shell_command",
			"read_file",
			"write_file",
			"edit",
			"glob",
			"grep_search",
		]);
		expect(await schemaOf(tools, "edit")).toEqual({
			properties: ["file_path", "old_string", "new_string", "replace_all"],
			required: ["file_path", "old_string", "new_string"],
		});
	});

	it("core: read, write, edit{edits[]}, bash", async () => {
		const tools = lean("core");
		expect(Object.keys(tools)).toEqual(["read", "write", "edit", "bash"]);
		expect(await schemaOf(tools, "read")).toEqual({
			properties: ["path", "offset", "limit"],
			required: ["path"],
		});
		expect(await schemaOf(tools, "edit")).toEqual({
			properties: ["path", "edits"],
			required: ["path", "edits"],
		});
		expect(await schemaOf(tools, "bash")).toEqual({
			properties: ["command", "timeout"],
			required: ["command"],
		});
	});
});

describe("the wiring point", () => {
	it("keeps the current surface unchanged and gives lean surfaces only their tools plus report_task_blocked", () => {
		const { tools } = commandRunner({});
		tools.apply_patch = tools.execute_command;
		tools.check_deliverable = tools.execute_command;
		const context = {
			workspace: async () => ({ machines, vm: WorkspaceId("vm"), cwd: repo }),
			sessionId,
			turnId: "turn",
			signal: new AbortController().signal,
		};
		const current = builderToolSurface({
			variant: "current",
			modelId: "anthropic/claude-opus-5.5",
			tools,
			lean: context,
		});
		expect(current.lean).toBeUndefined();
		expect(Object.keys(current.tools)).toContain("check_deliverable");
		const native = builderToolSurface({
			variant: "lean-native",
			modelId: "anthropic/claude-opus-5.5",
			tools,
			lean: context,
		});
		expect(native.lean?.shape).toBe("claude");
		expect(Object.keys(native.tools)).toEqual([
			"Bash",
			"Read",
			"Write",
			"Edit",
			"Glob",
			"Grep",
			"report_task_blocked",
		]);
		const core = builderToolSurface({
			variant: "lean",
			modelId: "gpt-6.1-sol",
			tools,
			lean: context,
		});
		expect(core.lean?.shape).toBe("core");
		for (const surface of [native, core]) {
			const names = Object.keys(surface.tools);
			// Offered as given (no search_tools/compose_tools) with no v13 tool profile.
			expect(isShellSurface(names)).toBe(true);
			expect(leanSurfaceShape(names)).toBe(surface.lean?.shape);
			expect(harnessModelToolInstructions("anthropic", false, names)).toContain(
				"v13-lean",
			);
		}
		expect(native.lean?.waitHint(["x"])).toContain("ytimesy-job wait");
	});
});

describe("commands run on the shared runner", () => {
	const id = randomUUID();

	it("Codex exec_command yields with a session id, write_stdin returns only newer output, Ctrl-C stops", async () => {
		const runner = commandRunner({
			execute_command: [
				{ id, status: "running", stdout: "booting\n", start: 0, nextStart: 8 },
			],
			continue_command: [
				{ status: "running", stdout: "ready\n", start: 8, nextStart: 14 },
			],
			stop_command: [{ id, status: "stopped" }],
		});
		await writeFile(`${outputs}/${id}.stdout`, "booting\nready\n^C\n");
		const tools = lean("codex", runner.tools);
		const started = (await run(tools, "exec_command", {
			cmd: "npm run dev",
			workdir: "web",
			yield_time_ms: 2000,
		})) as LeanCommandResult;
		expect(runner.calls[0]).toEqual({
			tool: "execute_command",
			args: {
				command: "cd 'web' && npm run dev",
				maxSeconds: 600,
				yieldSeconds: 2,
			},
		});
		expect(started).toMatchObject({
			id,
			status: "running",
			output: "booting\n",
		});
		expect(await modelText(tools, "exec_command", {}, started)).toContain(
			`Process running with session ID ${id}`,
		);
		const polled = (await run(tools, "write_stdin", {
			session_id: id,
			chars: "",
			yield_time_ms: 5000,
		})) as LeanCommandResult;
		expect(runner.calls[1]).toEqual({
			tool: "continue_command",
			args: { id, start: 8, seconds: 5 },
		});
		expect(polled.output).toBe("ready\n");
		const stopped = (await run(tools, "write_stdin", {
			session_id: id,
			chars: "\u0003",
		})) as LeanCommandResult;
		expect(runner.calls[2]).toEqual({ tool: "stop_command", args: { id } });
		expect(stopped).toMatchObject({ status: 130, output: "^C\n" });
		await expect(
			run(tools, "write_stdin", { session_id: 7, chars: "" }),
		).rejects.toThrow(/Unknown session ID/);
	});

	it("Claude Bash waits for a foreground command and reports the exit code", async () => {
		const runner = commandRunner({
			execute_command: [
				{ id, status: "running", stdout: "", start: 0, nextStart: 0 },
			],
			continue_command: [
				{ status: 2, stdout: "FAILED test_x\n", start: 0, nextStart: null },
			],
		});
		const tools = lean("claude", runner.tools);
		const result = (await run(tools, "Bash", {
			command: "pytest",
			timeout: 300_000,
		})) as LeanCommandResult;
		expect(runner.calls.map((call) => call.args)).toEqual([
			{ command: "pytest", maxSeconds: 300, yieldSeconds: 30 },
			{ id, start: 0, seconds: 300 },
		]);
		expect(await modelText(tools, "Bash", {}, result)).toBe(
			"FAILED test_x\n\nExit code 2",
		);
	});

	it("Claude Bash in the background returns the id, output file and ytimesy-job controls", async () => {
		const runner = commandRunner({
			execute_command: [
				{ id, status: "running", stdout: "", start: 0, nextStart: 0 },
			],
		});
		const tools = lean("claude", runner.tools);
		const result = (await run(tools, "Bash", {
			command: "npm run dev",
			run_in_background: true,
		})) as LeanCommandResult;
		expect(runner.calls[0].args).toEqual({
			command: "npm run dev",
			maxSeconds: 600,
			yieldSeconds: 0,
		});
		// Background tracking reads the raw result's id and status.
		expect(result).toMatchObject({ id, status: "running" });
		const text = await modelText(tools, "Bash", {}, result);
		expect(text).toContain(`${outputs}/${id}.stdout`);
		expect(text).toContain(`ytimesy-job stop ${id}`);
	});

	it("keeps the tail of long output and points at the full file", async () => {
		const long = randomUUID();
		const text = Array.from(
			{ length: 2500 },
			(_, index) => `row ${index + 1}`,
		).join("\n");
		await writeFile(`${outputs}/${long}.stdout`, `${text}\n`);
		const runner = commandRunner({
			execute_command: [
				{
					id: long,
					status: 0,
					stdout: text.slice(0, 32_000),
					start: 0,
					nextStart: 32_000,
				},
			],
		});
		const tools = lean("core", runner.tools);
		const result = (await run(tools, "bash", {
			command: "seq",
		})) as LeanCommandResult;
		expect(result.output.startsWith("row 501\n")).toBe(true);
		expect(result.output.endsWith("row 2500")).toBe(true);
		expect(result.truncationNote).toBe(
			`[Output cut to lines 501-2500 of 2500; all of it is in ${outputs}/${long}.stdout]`,
		);
		expect(await modelText(tools, "bash", {}, result)).toContain("row 2500");
	});

	it("Gemini run_shell_command runs in dir_path and reports in Gemini CLI's format", async () => {
		const runner = commandRunner({
			execute_command: [
				{ id, status: 0, stdout: "ok\n", start: 0, nextStart: null },
			],
		});
		const tools = lean("gemini", runner.tools);
		const args = { command: "make", dir_path: "/srv/app" };
		const result = await run(tools, "run_shell_command", args);
		expect(runner.calls[0].args.command).toBe("cd '/srv/app' && make");
		expect(await modelText(tools, "run_shell_command", args, result)).toBe(
			"Command: make\nDirectory: /srv/app\nOutput: ok\n\nExit Code: 0",
		);
	});
});

describe("files go through one reader, writer and edit engine", () => {
	it("Claude Read shows cat -n lines from an offset and notes what is left", async () => {
		await writeFile(
			join(repo, "src/a.py"),
			Array.from({ length: 2100 }, (_, index) => `x${index + 1}`).join("\n"),
		);
		const tools = lean("claude");
		const page = (await run(tools, "Read", {
			file_path: join(repo, "src/a.py"),
			offset: 2,
			limit: 3,
		})) as string;
		expect(page).toBe(
			"     2\tx2\n     3\tx3\n     4\tx4\n\n[Lines 2-4 of 2100; read on from offset 5.]",
		);
		const whole = (await run(tools, "Read", {
			file_path: "src/a.py",
		})) as string;
		expect(whole).toContain(
			"[Lines 1-2000 of 2100; read on from offset 2001.]",
		);
	});

	it("Gemini read_file takes start_line/end_line; core read takes offset; missing files are errors", async () => {
		await writeFile(join(repo, "b.txt"), "one\ntwo\nthree\n");
		expect(
			await run(lean("gemini"), "read_file", {
				file_path: "b.txt",
				start_line: 2,
				end_line: 3,
			}),
		).toContain("two\nthree");
		expect(await run(lean("core"), "read", { path: "b.txt" })).toBe(
			"one\ntwo\nthree",
		);
		await expect(
			run(lean("core"), "read", { path: "nope.txt" }),
		).rejects.toThrow(/does not exist/);
	});

	it("returns images as images", async () => {
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
			"base64",
		);
		await writeFile(join(repo, "shot.png"), png);
		const tools = lean("claude");
		const output = await run(tools, "Read", { file_path: "shot.png" });
		const model = (await tools.Read.toModelOutput?.({
			toolCallId: "c",
			input: {} as never,
			output,
		})) as { type: string; value: { type: string; mediaType?: string }[] };
		expect(model.type).toBe("content");
		expect(model.value[1]).toMatchObject({
			type: "file",
			mediaType: "image/png",
		});
		const codex = lean("codex");
		expect(await run(codex, "view_image", { path: "shot.png" })).toMatchObject({
			image: "image/png",
		});
	});

	it("Write creates parents; Edit falls back to the fuzzy match and changes only its region", async () => {
		const tools = lean("claude");
		expect(
			await run(tools, "Write", {
				file_path: join(repo, "deep/new/file.js"),
				content: "const greeting = “hello”;   \nkeep();\t\n",
			}),
		).toContain("Created");
		expect(
			await run(tools, "Edit", {
				file_path: "deep/new/file.js",
				old_string: 'const greeting = "hello";',
				new_string: 'const greeting = "bye";',
			}),
		).toContain("after normalizing");
		expect(await readFile(join(repo, "deep/new/file.js"), "utf8")).toBe(
			'const greeting = "bye";\nkeep();\t\n',
		);
		await expect(
			run(tools, "Edit", {
				file_path: "deep/new/file.js",
				old_string: "missing",
				new_string: "x",
			}),
		).rejects.toThrow(/old_string was not found/);
	});

	it("core edit applies several edits in one call; Qwen edit honours replace_all", async () => {
		await writeFile(join(repo, "c.txt"), "one\ntwo\nthree\n");
		expect(
			await run(lean("core"), "edit", {
				path: "c.txt",
				edits: [
					{ oldText: "one", newText: "1" },
					{ oldText: "three", newText: "3" },
				],
			}),
		).toContain("2 edits applied");
		expect(await readFile(join(repo, "c.txt"), "utf8")).toBe("1\ntwo\n3\n");
		await writeFile(join(repo, "c.txt"), "a\nb\na\n");
		await expect(
			run(lean("core"), "edit", {
				path: "c.txt",
				edits: [
					{ oldText: "a\nb", newText: "A\nB" },
					{ oldText: "b\na\n", newText: "x" },
				],
			}),
		).rejects.toThrow(/overlap/);
		await run(lean("qwen"), "edit", {
			file_path: "c.txt",
			old_string: "a",
			new_string: "z",
			replace_all: true,
		});
		expect(await readFile(join(repo, "c.txt"), "utf8")).toBe("z\nb\nz\n");
	});

	it("Glob and Grep search with ripgrep", async () => {
		await writeFile(join(repo, "src/needle.ts"), "export const needle = 1;\n");
		const tools = lean("claude");
		expect(await run(tools, "Glob", { pattern: "**/*.ts" })).toContain(
			"src/needle.ts",
		);
		expect(await run(tools, "Grep", { pattern: "needle =" })).toContain(
			"src/needle.ts",
		);
		expect(
			await run(tools, "Grep", { pattern: "needle =", output_mode: "content" }),
		).toContain("1:export const needle = 1;");
		expect(await run(tools, "Grep", { pattern: "absent_zzz" })).toBe(
			"No matches found",
		);
		expect(
			await run(lean("gemini"), "grep_search", {
				pattern: "needle",
				include: "*.ts",
			}),
		).toContain("needle.ts:1:");
	});
});

describe("lean writes go through the runtime's checked edit", () => {
	it("refuses .git, symlinks and paths outside the repository and ~/memory, and leaves no temp file", async () => {
		const tools = lean("claude");
		await mkdir(join(repo, ".git"), { recursive: true });
		await expect(
			run(tools, "Write", {
				file_path: join(repo, ".git/config"),
				content: "x",
			}),
		).rejects.toThrow(/\.git/);
		const outside = join(root, "outside.txt");
		await expect(
			run(tools, "Write", { file_path: outside, content: "x" }),
		).rejects.toThrow(/outside the repository/);
		await writeFile(outside, "secret\n");
		await symlink(outside, join(repo, "link.txt"));
		await expect(
			run(tools, "Write", { file_path: join(repo, "link.txt"), content: "x" }),
		).rejects.toThrow(/[Ss]ymlink/);
		expect(await readFile(outside, "utf8")).toBe("secret\n");
		await expect(
			run(tools, "Edit", {
				file_path: "link.txt",
				old_string: "secret",
				new_string: "x",
			}),
		).rejects.toThrow(/[Ss]ymlink/);
		expect(await readFile(outside, "utf8")).toBe("secret\n");
		expect(
			(await readdir(repo)).filter((name) => name.startsWith(".ytimesy-")),
		).toEqual([]);
	});

	it("writes inside ~/memory", async () => {
		await mkdir(join(root, "home/memory"), { recursive: true });
		expect(
			await run(lean("core"), "write", {
				path: "~/memory/notes.md",
				content: "- Uses pnpm\n",
			}),
		).toMatch(/^Created /);
		expect(await readFile(join(root, "home/memory/notes.md"), "utf8")).toBe(
			"- Uses pnpm\n",
		);
	});

	it("keeps write_stdin's cursor in the turn memo", async () => {
		const memo = new Map<string, unknown>();
		const id = randomUUID();
		const { tools: base, calls } = commandRunner({
			execute_command: [
				{ id, status: "running", stdout: "one\n", start: 0, nextStart: 4 },
			],
			continue_command: [
				{ id, status: "running", stdout: "two\n", start: 4, nextStart: 8 },
			],
		});
		const context = {
			workspace: async () => ({ machines, vm: WorkspaceId("vm"), cwd: repo }),
			sessionId,
			turnId: "turn",
			signal: new AbortController().signal,
			once: (_id: string, _fingerprint: string, run: () => Promise<unknown>) =>
				run(),
			installHelpers: async () => {},
			memo: async <T>(key: string, load: () => Promise<T>) => {
				if (!memo.has(key)) memo.set(key, await load());
				return memo.get(key) as T;
			},
		};
		await run(leanShapeTools("codex", base, context).tools, "exec_command", {
			cmd: "slow",
		});
		// Another step of the same turn builds its tools again.
		await run(leanShapeTools("codex", base, context).tools, "write_stdin", {
			session_id: id,
		});
		expect(calls.at(-1)?.args).toMatchObject({ id, start: 4 });
	});
});
