import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Tool, type ToolSet, tool } from "ai";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { z } from "zod";
import { applyApiProgress } from "#/domain/api-progress";
import {
	CODE_MODE_TOOL,
	type CodeModeResult,
	codeModeCallItems,
	codeModeResult,
	storedCodeModeResult,
} from "#/domain/code-mode";
import { DEFAULT_HARNESS_VARIANT } from "#/domain/harness-variant";
import { WorkspaceId } from "#/domain/ids";
import type { DynamicToolCallItem } from "#/domain/session-item";
import { toolActivity } from "#/domain/tool-detail";
import { agentOutputDirectory } from "./agent-output-artifacts";
import { agentTurnInstructions } from "./agent-turn-instructions";
import { codeModeModelText, codeModeTool } from "./code-mode-tool";
import { leanShapeTools } from "./lean-tools";
import { withPlanMode } from "./plan-mode";
import { withRedactedResults } from "./redacted-tools";
import type { WorkspaceMachines } from "./workspace-machines";

/** An in-memory receipts journal with the table's semantics (claim, processing, done). */
const receipts = vi.hoisted(
	() =>
		new Map<
			string,
			{ status: "processing" | "done"; response?: Record<string, unknown> }
		>(),
);
vi.mock("../adapters/agent-task-command-receipts", () => ({
	claimAgentTaskCommand: async (_session: string, id: string) => {
		const row = receipts.get(id);
		if (!row) {
			receipts.set(id, { status: "processing" });
			return { kind: "claimed" };
		}
		return row.status === "done"
			? { kind: "done", response: row.response }
			: { kind: "processing" };
	},
	completeAgentTaskCommand: async (
		_session: string,
		response: { id: string },
	) => {
		receipts.set(response.id, { status: "done", response });
	},
	renewAgentTaskCommandClaim: async () => {},
}));

let root: string;
let repo: string;
const sessionId = randomUUID();
const outputs = agentOutputDirectory(sessionId);
/** Every command the workspace actually ran, in order. */
let ran: string[] = [];

function sh(command: string) {
	return new Promise<{ exitCode: number; stdout: string; stderr: string }>(
		(done) =>
			execFile(
				"bash",
				["-c", command],
				{ cwd: repo, maxBuffer: 64 * 1024 * 1024 },
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

/**
 * The runtime's command runner, like apiAgentTools': journaled by call id
 * (the receipts mock), the whole output kept in the output file.
 */
function commandRunner(): ToolSet {
	const { journaledToolOperation } = journal;
	return {
		execute_command: tool({
			inputSchema: z.object({ command: z.string() }).passthrough(),
			execute: ({ command }, options) =>
				journaledToolOperation(
					{
						sessionId,
						requestId: `turn:${options.toolCallId}`,
						fingerprint: createHash("sha256").update(command).digest("hex"),
						signal: options.abortSignal ?? new AbortController().signal,
					},
					async () => {
						ran.push(command);
						const id = `cmd-${createHash("sha256").update(command).digest("hex").slice(0, 8)}`;
						const result = await sh(command);
						const stdout = result.stdout + result.stderr;
						await writeFile(join(outputs, `${id}.stdout`), stdout);
						return {
							id,
							status: result.exitCode,
							stdout,
							start: 0,
							nextStart: null,
						};
					},
				),
		}),
		continue_command: tool({
			inputSchema: z.object({}).passthrough(),
			execute: async (): Promise<unknown> => {
				throw new Error("unexpected continue_command");
			},
		}),
		stop_command: tool({
			inputSchema: z.object({}).passthrough(),
			execute: async () => ({ status: "stopped" }),
		}),
	};
}
const journal = await import("./journaled-tool-operation");

/** The lean core surface over a real temporary repository, writes journaled by call id. */
function coreSurface() {
	return leanShapeTools("core", commandRunner(), {
		workspace: async () => ({ machines, vm: WorkspaceId("vm"), cwd: repo }),
		sessionId,
		turnId: "turn",
		signal: new AbortController().signal,
		installHelpers: async () => {},
	}).tools;
}

const options = (toolCallId = "call-1", abortSignal?: AbortSignal) =>
	({ toolCallId, messages: [], abortSignal, context: {} }) as Parameters<
		NonNullable<Tool["execute"]>
	>[1];

function runCodeTool(tools: ToolSet, signal = new AbortController().signal) {
	const runCode = codeModeTool({
		tools,
		signal,
		sessionId,
		turnId: "turn",
	});
	if (!runCode?.execute) throw new Error("run_code unavailable");
	return runCode;
}

async function runCode(
	tools: ToolSet,
	code: string,
	input: { toolCallId?: string; timeout?: number; signal?: AbortSignal } = {},
) {
	return (await runCodeTool(tools, input.signal).execute?.(
		{ code, ...(input.timeout ? { timeout: input.timeout } : {}) },
		options(input.toolCallId ?? randomUUID()),
	)) as CodeModeResult;
}

/** What the model sees from a direct call (its toModelOutput), or the error it gets. */
async function direct(tools: ToolSet, name: string, args: unknown) {
	try {
		const toolCallId = randomUUID();
		const output = await tools[name].execute?.(
			args as never,
			options(toolCallId),
		);
		const shown = await tools[name].toModelOutput?.({
			toolCallId,
			input: args as never,
			output,
		});
		return { ok: true, text: (shown as { value: string }).value };
	} catch (error) {
		return { ok: false, text: (error as Error).message };
	}
}

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "code-mode-"));
	repo = join(root, "repo");
	await mkdir(join(repo, "src"), { recursive: true });
	await mkdir(outputs, { recursive: true });
});
afterAll(async () => {
	await rm(root, { recursive: true, force: true });
	await rm(outputs, { recursive: true, force: true });
});
beforeEach(() => {
	receipts.clear();
	ran = [];
});

describe("run_code on the lean surface", () => {
	it("is off by default and offers the lean tools and MCP, never provider-hosted tools", () => {
		expect(DEFAULT_HARNESS_VARIANT.codeMode).toBe("off");
		const runCode = codeModeTool({
			tools: {
				...coreSurface(),
				web_search: {
					type: "provider",
					execute: async () => null,
				} as unknown as Tool,
				search_mcp_tools: tool({
					inputSchema: z.object({ query: z.string() }),
					execute: async () => [],
				}),
				propose_plan: tool({
					inputSchema: z.object({}),
					execute: async () => null,
				}),
				report_task_blocked: tool({
					inputSchema: z.object({}),
					execute: async () => null,
				}),
			},
			signal: new AbortController().signal,
			sessionId,
			turnId: "turn",
		});
		const description = runCode?.description ?? "";
		for (const name of ["read", "write", "edit", "bash", "search_mcp_tools"])
			expect(description).toContain(`tools.${name}(args)`);
		for (const name of ["web_search", "propose_plan", "report_task_blocked"])
			expect(description).not.toContain(`tools.${name}(`);
		expect(
			codeModeTool({
				tools: {},
				signal: new AbortController().signal,
				sessionId,
				turnId: "turn",
			}),
		).toBeUndefined();
	});

	it("lets a program call the deferred subagent tools without loading them", () => {
		const runCode = codeModeTool({
			tools: {
				...coreSurface(),
				agent: tool({
					inputSchema: z.object({}),
					execute: async () => null,
				}),
				agent_send: tool({
					inputSchema: z.object({}),
					execute: async () => null,
				}),
				find_tools: tool({
					inputSchema: z.object({}),
					execute: async () => null,
				}),
			},
			signal: new AbortController().signal,
			sessionId,
			turnId: "turn",
		});
		const description = runCode?.description ?? "";
		expect(description).toContain("tools.agent(args)");
		expect(description).toContain("tools.agent_send(args)");
		expect(description).not.toContain("tools.find_tools(");
	});

	it("tells the model when to use run_code only when it is offered", () => {
		const instructions = (tools: ToolSet) =>
			agentTurnInstructions({
				session: { parentSessionId: null } as never,
				tools,
				plugins: [] as never,
				projectKnowledge: null,
				leanShape: "core",
			});
		const tools = coreSurface();
		expect(instructions(tools)).not.toContain("run_code");
		const offered = instructions({
			...tools,
			[CODE_MODE_TOOL]: runCodeTool(tools),
		});
		expect(offered).toContain("run_code runs one JavaScript program");
		expect(offered).toContain("Promise.all");
		expect(offered).toContain("interactive or long-running processes");
	});

	it("gives a program exactly what direct calls give the model, errors and output limits included", async () => {
		await writeFile(join(repo, "src/a.txt"), "alpha\nbeta\n");
		const tools = coreSurface();
		const program = await runCode(
			tools,
			`const read = await tools.read({ path: "src/a.txt" });
			let missing; try { await tools.read({ path: "src/nope.txt" }); } catch (error) { missing = error.message; }
			const failed = await tools.bash({ command: "echo out; echo err >&2; exit 3" });
			const long = await tools.bash({ command: "seq 1 3000" });
			let badEdit; try { await tools.edit({ path: "src/a.txt", edits: [{ old_string: "gamma", new_string: "x" }] }); } catch (error) { badEdit = error.message; }
			let invalid; try { await tools.read({ path: 42 }); } catch (error) { invalid = error.message; }
			return { read, missing, failed, longTail: long.output.slice(-300), longLines: long.output.split("\\n").length, badEdit, invalid };`,
		);
		expect(program.ok).toBe(true);
		const value = JSON.parse(program.result as string);
		const read = await direct(tools, "read", { path: "src/a.txt" });
		const missing = await direct(tools, "read", { path: "src/nope.txt" });
		const failed = await direct(tools, "bash", {
			command: "echo out; echo err >&2; exit 3",
		});
		const long = await direct(tools, "bash", { command: "seq 1 3000" });
		const badEdit = await direct(tools, "edit", {
			path: "src/a.txt",
			edits: [{ old_string: "gamma", new_string: "x" }],
		});
		expect(value.read).toBe(read.text);
		expect(missing.ok).toBe(false);
		expect(value.missing).toBe(missing.text);
		expect(value.failed).toEqual({ output: failed.text, exitCode: 3 });
		expect(failed.text).toContain("Command exited with code 3");
		// The lean limit (2000 lines, tail kept, full output in a file) applies inside programs too.
		expect(long.text).toMatch(/\[Output cut to lines 1001-3000 of 3000/);
		expect(value.longTail).toBe(long.text.slice(-300));
		expect(value.longLines).toBe(long.text.split("\n").length);
		expect(badEdit.ok).toBe(false);
		expect(value.badEdit).toBe(badEdit.text);
		expect(value.invalid).toMatch(/Invalid arguments for read/);
		expect(program.calls.map((call) => [call.tool, call.status])).toEqual([
			["read", "completed"],
			["read", "failed"],
			["bash", "failed"],
			["bash", "completed"],
			["edit", "failed"],
			["read", "failed"],
		]);
	});

	it("runs independent calls concurrently and returns one compact log line per call", async () => {
		await writeFile(join(repo, "src/b.txt"), "b\n");
		const started = performance.now();
		const result = await runCode(
			coreSurface(),
			`const [x, y, z] = await Promise.all([
				tools.bash({ command: "sleep 0.4; echo x" }),
				tools.bash({ command: "sleep 0.4; echo y" }),
				tools.read({ path: "src/b.txt" }),
			]);
			console.log("exit codes", x.exitCode, y.exitCode);
			return x.output.trim() + y.output.trim() + z;`,
		);
		expect(performance.now() - started).toBeLessThan(1_100);
		expect(result).toMatchObject({
			ok: true,
			result: "xyb",
			console: "exit codes 0 0\n",
		});
		const text = codeModeModelText(result);
		expect(text.split("\n")).toEqual([
			"xyb",
			"",
			"Console:",
			"exit codes 0 0",
			"",
			"Tool calls (3):",
			expect.stringMatching(
				/^1\. bash \{"command":"sleep 0\.4; echo x"\} → completed \(\d+ ms\): \{"output":"x\\n","exitCode":0\}$/,
			),
			expect.stringMatching(/^2\. bash /),
			expect.stringMatching(/^3\. read \{"path":"src\/b\.txt"\} → completed/),
		]);
	});

	it("caps the return value at the lean limit with a note", async () => {
		const result = await runCode(
			coreSurface(),
			"return Array.from({ length: 2500 }, (_, i) => 'line ' + i).join('\\n');",
		);
		expect(result.result?.split("\n").length).toBeLessThanOrEqual(2003);
		expect(result.result).toMatch(
			/\[Return value cut to lines 1-2000 of 2500; return less/,
		);
	});

	it("isolates the program: no host globals, no escape through the tool functions", async () => {
		const result = await runCode(
			coreSurface(),
			`const viaConstructor = tools.read.constructor("return typeof process + typeof require + typeof fetch")();
			return {
				viaConstructor,
				globals: [typeof process, typeof require, typeof fetch, typeof setTimeout, typeof WebAssembly, typeof __ytimesyCall].join(","),
				frozen: Object.isFrozen(tools),
			};`,
		);
		expect(JSON.parse(result.result as string)).toEqual({
			viaConstructor: "undefinedundefinedundefined",
			globals: "undefined,undefined,undefined,undefined,undefined,undefined",
			frozen: true,
		});
		const imported = await runCode(
			coreSurface(),
			'const fs = await import("node:fs"); return fs.readFileSync("/etc/passwd", "utf8");',
		);
		expect(imported.ok).toBe(false);
		expect(imported.calls).toEqual([]);
	});

	it("stops mid-program when the turn is cancelled, without starting later calls", async () => {
		const controller = new AbortController();
		const outcome = runCode(
			coreSurface(),
			`await tools.bash({ command: "sleep 0.3; echo first" });
			await tools.bash({ command: "echo second > src/second.txt" });
			return "done";`,
			{ signal: controller.signal },
		);
		setTimeout(() => controller.abort(new Error("turn cancelled")), 100);
		await expect(outcome).rejects.toThrow("turn cancelled");
		expect(ran).toEqual(["sleep 0.3; echo first"]);
		await expect(readFile(join(repo, "src/second.txt"))).rejects.toThrow();
	});

	it("stops at its own timeout and reports the calls that ran", async () => {
		const result = await runCode(
			coreSurface(),
			`await tools.bash({ command: "sleep 1.5" });
			await tools.bash({ command: "echo late" });
			return 1;`,
			{ timeout: 1 },
		);
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/1 s time limit/);
		expect(ran).toEqual(["sleep 1.5"]);
	});

	it("keeps plan mode: writes and edits are refused inside a program, reads work", async () => {
		await writeFile(join(repo, "src/plan.txt"), "original\n");
		const tools = withPlanMode(coreSurface(), () => true);
		const result = await runCode(
			tools,
			`const before = await tools.read({ path: "src/plan.txt" });
			const refusals = [];
			for (const attempt of [
				() => tools.write({ path: "src/plan.txt", content: "changed" }),
				() => tools.edit({ path: "src/plan.txt", edits: [{ old_string: "original", new_string: "changed" }] }),
				// Shell writes are refused as for a direct call: best effort, heredoc writes.
				() => tools.bash({ command: "cat > src/plan.txt <<'EOF'\\nchanged\\nEOF" }),
			]) {
				try { await attempt(); refusals.push("ran"); } catch (error) { refusals.push(error.message); }
			}
			return { before, refusals };`,
		);
		const value = JSON.parse(result.result as string);
		expect(value.before).toBe("original");
		expect(value.refusals).toEqual([
			expect.stringMatching(/^Plan mode:/),
			expect.stringMatching(/^Plan mode:/),
			expect.stringMatching(/^Plan mode:/),
		]);
		expect(result.calls.map((call) => call.status)).toEqual([
			"completed",
			"refused",
			"refused",
			"refused",
		]);
		expect(await readFile(join(repo, "src/plan.txt"), "utf8")).toBe(
			"original\n",
		);
	});

	it("sees only redacted results, and its own result is redacted again", async () => {
		const secret = "ghs_codeModeSecret123";
		const tools = withRedactedResults(coreSurface(), [secret]);
		const runCode = withRedactedResults(
			{ [CODE_MODE_TOOL]: runCodeTool(tools) },
			[secret],
		)[CODE_MODE_TOOL];
		const result = (await runCode.execute?.(
			{
				code: `const shown = await tools.bash({ command: "echo token=${secret}" });
				return { shown: shown.output, leaked: shown.output.includes("ghs_") , typed: "${secret}" };`,
			},
			options("redact"),
		)) as CodeModeResult;
		const text = JSON.stringify(result);
		expect(text).not.toContain(secret);
		expect(JSON.parse(result.result as string)).toMatchObject({
			leaked: false,
		});
		expect(result.result).toContain("[REDACTED]");
	});

	it("replays a completed run from the journal instead of running it again", async () => {
		const code = `await tools.bash({ command: "echo once >> src/count.txt" });
			return (await tools.read({ path: "src/count.txt" }));`;
		const first = await runCode(coreSurface(), code, { toolCallId: "call-j" });
		// The step restarts: a fresh tool set, the same model tool call.
		const again = await runCode(coreSurface(), code, { toolCallId: "call-j" });
		expect(again).toEqual(first);
		expect(ran).toEqual(["echo once >> src/count.txt"]);
		expect(await readFile(join(repo, "src/count.txt"), "utf8")).toBe("once\n");
		expect(receipts.get("turn:call-j:code")?.status).toBe("done");
	});

	it("re-runs an interrupted run with each inner side effect replayed from its own receipt", async () => {
		const code = `await tools.bash({ command: "echo run >> src/runs.txt" });
			await tools.write({ path: "src/written.txt", content: "w" });
			return (await tools.read({ path: "src/runs.txt" }));`;
		const first = await runCode(coreSurface(), code, { toolCallId: "call-i" });
		expect(first.result).toBe("run");
		// The run was cut off before its own record was written.
		receipts.delete("turn:call-i:code");
		await writeFile(join(repo, "src/written.txt"), "changed since");
		const resumed = await runCode(coreSurface(), code, {
			toolCallId: "call-i",
		});
		expect(resumed.result).toBe("run");
		expect(ran).toEqual(["echo run >> src/runs.txt"]);
		// The write was replayed, not repeated.
		expect(await readFile(join(repo, "src/written.txt"), "utf8")).toBe(
			"changed since",
		);
		expect([...receipts.keys()].sort()).toEqual([
			"turn:call-i:code",
			"turn:call-i:code:0",
			"turn:call-i:code:1",
		]);
	});

	it("refuses to reuse a recorded run for a different program", async () => {
		await runCode(coreSurface(), 'return "a";', { toolCallId: "call-f" });
		await expect(
			runCode(coreSurface(), 'return "b";', { toolCallId: "call-f" }),
		).rejects.toThrow(/Recorded tool inputs differ/);
	});
});

describe("run_code in the chat", () => {
	const item = (output: CodeModeResult): DynamicToolCallItem =>
		applyApiProgress(
			applyApiProgress([], "turn", {
				type: "tool-call",
				id: "c1",
				name: CODE_MODE_TOOL,
				input: { code: "return 1;" },
			}),
			"turn",
			{
				type: "tool-result",
				id: "c1",
				name: CODE_MODE_TOOL,
				output,
			},
		)[0] as DynamicToolCallItem;

	it("records one card whose inner calls render as ordinary tool cards", () => {
		const card = item({
			ok: true,
			result: "1",
			calls: [
				{
					tool: "read",
					input: '{"path":"src/a.ts"}',
					status: "completed",
					ms: 3,
					output: "x",
				},
				{
					tool: "read",
					input: '{"path":"src/b.ts"}',
					status: "completed",
					ms: 3,
					output: "y",
				},
				{
					tool: "bash",
					input: '{"command":"npm test"}',
					status: "failed",
					ms: 9,
					output: '{"output":"1 failed","exitCode":1}',
				},
			],
		});
		expect(toolActivity(card)).toMatchObject({
			verb: "Ran code",
			target: "read ×2 · bash",
			note: "3 calls, 1 not completed",
		});
		const inner = codeModeCallItems(card);
		expect(inner.map((call) => toolActivity(call).verb)).toEqual([
			"Read",
			"Read",
			"Ran",
		]);
		expect(inner[2]).toMatchObject({ status: "failed", tool: "bash" });
	});

	it("bounds a large run's record so it still parses", () => {
		const big = "z".repeat(5_000);
		const calls = Array.from({ length: 40 }, () => ({
			tool: "bash",
			input: big,
			status: "completed" as const,
			ms: 1,
			output: big,
		}));
		const card = item({ ok: true, result: big.repeat(10), calls });
		const stored = codeModeResult(card);
		expect(stored?.calls).toHaveLength(40);
		expect(card.output?.length).toBeLessThanOrEqual(16_000);
		expect(
			JSON.stringify(storedCodeModeResult({ ok: true, calls })).length,
		).toBeLessThan(16_000);
	});
});
