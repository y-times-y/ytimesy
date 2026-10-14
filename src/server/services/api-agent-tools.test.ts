import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import {
	claimAgentTaskCommand,
	completeAgentTaskCommand,
} from "../adapters/agent-task-command-receipts";
import { readModelContextArchive } from "../adapters/context-archives";
import { repositorySearchCommand } from "./api-agent-search-tools";
import { apiAgentTools } from "./api-agent-tools";
import { runAgentTaskTool } from "./harness-workspace-session";
import type { WorkspaceMachines } from "./workspace-machines";

vi.mock("../adapters/context-archives", async (original) => ({
	...(await original<typeof import("../adapters/context-archives")>()),
	readModelContextArchive: vi.fn(),
}));

vi.mock("../adapters/agent-task-command-receipts", () => ({
	claimAgentTaskCommand: vi.fn(async () => ({ kind: "claimed" })),
	completeAgentTaskCommand: vi.fn(async () => {}),
	renewAgentTaskCommandClaim: vi.fn(async () => {}),
}));
vi.mock("./harness-workspace-session", () => ({
	runAgentTaskTool: vi.fn(() => Effect.succeed({ peers: [] })),
}));

it("keeps control-plane tools usable while the execution VM is unavailable", async () => {
	const workspace = vi.fn(async () => {
		throw new Error("VM unavailable");
	});
	const tools = apiAgentTools({
		machines: {} as WorkspaceMachines,
		session: {
			id: "lead",
			userId: "owner",
			projectId: "project",
			providerRef: null,
			harness: "codex",
			taskAccess: "read_only",
		} as AgentSessionRecord,
		workspace,
		turnId: "turn",
		signal: new AbortController().signal,
	});
	expect(workspace).not.toHaveBeenCalled();
	expect(await executeInspectionTool(tools.list_peers, {})).toEqual({
		peers: [],
	});
	expect(workspace).not.toHaveBeenCalled();
	await expect(executeInspectionTool(tools.list_files, {})).rejects.toThrow(
		"VM unavailable",
	);
});

it("binds batched review reads to each original authorized tool and its arguments", async () => {
	const { tools } = leadTools();
	vi.mocked(runAgentTaskTool)
		.mockImplementationOnce(() =>
			Effect.succeed({ sha256: "exact", nextStart: 200 }),
		)
		.mockImplementationOnce(() =>
			Effect.succeed({ sourcesCurrent: true, checks: [] }),
		);
	const result = await executeInspectionTool(tools.batch_read, {
		reads: [
			{ tool: "inspect_task_diff", arguments: { taskId: "child" } },
			{
				tool: "read_task_checks",
				arguments: { taskId: "child", references: ["proof"] },
			},
		],
	});
	expect(result).toMatchObject({
		reads: [
			{ status: "completed", result: { sha256: "exact", nextStart: 200 } },
			{ status: "completed", result: { sourcesCurrent: true } },
		],
	});
	for (const [index, name] of [
		"inspect_task_diff",
		"read_task_checks",
	].entries()) {
		expect(claimAgentTaskCommand).toHaveBeenCalledWith(
			"lead",
			`turn-1:inspection:read:${index}`,
		);
		expect(runAgentTaskTool).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.objectContaining({
				id: `inspection:read:${index}`,
				tool: name,
				arguments: expect.objectContaining({ taskId: "child" }),
			}),
			expect.anything(),
		);
	}
});

it("records failed execution and replays its cause without repeating a potentially partial effect", async () => {
	const { tools } = leadTools();
	vi.mocked(claimAgentTaskCommand).mockResolvedValueOnce({ kind: "claimed" });
	vi.mocked(runAgentTaskTool).mockImplementationOnce(() =>
		Effect.fail(new Error("Peer unavailable")),
	);
	await expect(executeInspectionTool(tools.list_peers, {})).rejects.toThrow(
		"Peer unavailable",
	);
	const completed = vi.mocked(completeAgentTaskCommand).mock.calls.at(-1)?.[1];
	expect(completed).toMatchObject({
		ok: false,
		error: expect.stringContaining("partial effects may exist"),
	});
	if (!completed) throw new Error("Failure receipt was not persisted");
	vi.mocked(claimAgentTaskCommand).mockResolvedValueOnce({
		kind: "done",
		response: completed,
	});
	const calls = vi.mocked(runAgentTaskTool).mock.calls.length;
	await expect(executeInspectionTool(tools.list_peers, {})).rejects.toThrow(
		"Peer unavailable",
	);
	expect(runAgentTaskTool).toHaveBeenCalledTimes(calls);
});

it("refuses a reused call ID with changed arguments before executing another operation", async () => {
	const { tools } = leadTools();
	vi.mocked(claimAgentTaskCommand).mockResolvedValueOnce({ kind: "claimed" });
	await executeInspectionTool(tools.list_peers, {});
	const completed = vi.mocked(completeAgentTaskCommand).mock.calls.at(-1)?.[1];
	if (!completed) throw new Error("Tool receipt was not persisted");
	vi.mocked(claimAgentTaskCommand).mockResolvedValueOnce({
		kind: "done",
		response: completed,
	});
	const calls = vi.mocked(runAgentTaskTool).mock.calls.length;
	await expect(
		executeInspectionTool(tools.list_peers, { changed: true }),
	).rejects.toThrow("No operation was replayed");
	expect(runAgentTaskTool).toHaveBeenCalledTimes(calls);
});

it("does not infer matching inputs from a legacy receipt without a fingerprint", async () => {
	const { tools } = leadTools();
	vi.mocked(claimAgentTaskCommand).mockResolvedValueOnce({
		kind: "done",
		response: { id: "inspection", ok: true, result: { peers: [] } },
	});
	const calls = vi.mocked(runAgentTaskTool).mock.calls.length;
	await expect(executeInspectionTool(tools.list_peers, {})).rejects.toThrow(
		"predate input validation",
	);
	expect(runAgentTaskTool).toHaveBeenCalledTimes(calls);
});

it("reads archived evidence without a VM, bounded and scoped to the current chat", async () => {
	vi.mocked(readModelContextArchive).mockResolvedValue([
		{
			role: "assistant",
			content: [
				{
					type: "reasoning",
					text: "Earlier finding",
					providerOptions: { anthropic: { signature: "opaque-signature" } },
				},
			],
		},
	]);
	const workspace = vi.fn(async () => {
		throw new Error("VM unavailable");
	});
	const tools = apiAgentTools({
		machines: {} as WorkspaceMachines,
		session: { id: "chat", userId: "alice" } as AgentSessionRecord,
		workspace,
		turnId: "turn",
		signal: new AbortController().signal,
	});
	const reference = "context-00000000-0000-0000-0000-000000000001";
	const output = await executeInspectionTool(tools.read_context_archive, {
		reference,
		offset: 0,
		limit: 5,
		start: 0,
	});
	expect(readModelContextArchive).toHaveBeenCalledWith(
		"alice",
		"chat",
		reference,
		undefined,
	);
	expect(JSON.stringify(output)).toContain("Earlier finding");
	expect(JSON.stringify(output)).not.toContain("opaque-signature");
	expect(workspace).not.toHaveBeenCalled();
});

function leadTools() {
	const commands: string[] = [];
	const machines = {
		exec: async (_vm: string, command: string) => {
			commands.push(command);
			return {
				exitCode: 0,
				stdout: JSON.stringify({
					exitCode: 0,
					stdout: "README.md\n",
					stderr: "",
					reference: "fixture",
					stopped: null,
					stdoutNextStart: null,
					stderrNextStart: null,
				}),
				stderr: "",
			};
		},
	} as unknown as WorkspaceMachines;
	const session = {
		id: "lead",
		providerRef: "vm-lead",
		taskAccess: "read_only",
	} as AgentSessionRecord;
	return {
		commands,
		tools: apiAgentTools({
			machines,
			session,
			cwd: "/workspace/repo",
			turnId: "turn-1",
			signal: new AbortController().signal,
		}),
	};
}

it("separates repeated provider call IDs across durable steps", async () => {
	for (const index of [1, 2]) {
		const tools = apiAgentTools({
			machines: {} as WorkspaceMachines,
			session: { id: "lead", taskAccess: "read_only" } as AgentSessionRecord,
			workspace: async () => {
				throw new Error("No VM needed");
			},
			turnId: "turn",
			toolCallPrefix: `step-${index}:`,
			signal: new AbortController().signal,
		});
		await executeInspectionTool(tools.list_peers, {});
		expect(claimAgentTaskCommand).toHaveBeenCalledWith(
			"lead",
			`turn:step-${index}:inspection`,
		);
		expect(runAgentTaskTool).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ id: `step-${index}:inspection` }),
			expect.objectContaining({
				signal: expect.any(AbortSignal),
				turnId: "turn",
			}),
		);
	}
});

async function executeInspectionTool(
	tool: unknown,
	args: Record<string, unknown>,
) {
	const executable = tool as {
		execute: (
			args: Record<string, unknown>,
			options: unknown,
		) => Promise<unknown>;
	};
	return executable.execute(args, { toolCallId: "inspection" });
}

describe("read-only API lead tools", () => {
	it("does not enable writes from a legacy root access flag", () => {
		const tools = apiAgentTools({
			machines: {} as WorkspaceMachines,
			session: {
				id: "lead",
				taskAccess: "read_write",
				parentSessionId: null,
			} as AgentSessionRecord,
			workspace: async () => {
				throw new Error("unused");
			},
			turnId: "turn",
			signal: new AbortController().signal,
		});
		for (const name of [
			"create_file",
			"replace_text",
			"apply_patch",
			"bash",
			"start_command",
			"browser_execute",
		])
			expect(tools[name]).toBeUndefined();
	});
	it("does not offer a parent-only blocked-report tool to the root", () => {
		expect(leadTools().tools.report_task_blocked).toBeUndefined();
	});
	it("can inspect files without receiving a shell-writing tool", async () => {
		const { commands, tools } = leadTools();
		expect(tools.bash).toBeUndefined();
		for (const name of [
			"create_file",
			"replace_text",
			"start_command",
			"stop_command",
			"browser_execute",
			"debug_node",
		])
			expect(tools[name]).toBeUndefined();
		for (const name of [
			"inspect_changes",
			"verify_changes",
			"read_command",
			"browser_screenshot",
		])
			expect(tools[name]).toBeDefined();
		await executeInspectionTool(tools.list_files, {});
		await executeInspectionTool(tools.search_files, { query: "task" });
		expect(commands).toEqual([
			expect.stringContaining("ls-files --cached --others --exclude-standard"),
			expect.stringContaining("grep --untracked --exclude-standard -n -I"),
		]);
	});

	it("quotes search input so it cannot become another command", async () => {
		const { commands, tools } = leadTools();
		await executeInspectionTool(tools.search_files, {
			query: "a'; touch /tmp/unwanted; echo 'b",
		});
		expect(commands[0]).toContain("touch /tmp/unwanted");
		const command = repositorySearchCommand({
			cwd: "/workspace/repo",
			query: "a'; touch /tmp/unwanted; echo 'b",
			literal: false,
			path: ".",
		});
		expect(commands[0]).toContain(`'${command.replaceAll("'", "'\\''")}'`);
	});

	it("scopes listings and searches to literal task paths without Git pathspec expansion", async () => {
		const { commands, tools } = leadTools();
		await executeInspectionTool(tools.list_files, { path: "src/domain" });
		await executeInspectionTool(tools.search_files, {
			query: "validator",
			path: "src/[policy]",
		});
		expect(commands[0]).toContain("--literal-pathspecs");
		expect(commands[0]).toContain("--exclude-standard --");
		expect(commands[1]).toContain("--literal-pathspecs");
		expect(commands[1]).toContain("src/[policy]");
	});

	it("rejects out-of-repository and metadata search scopes before guest execution", async () => {
		const { commands, tools } = leadTools();
		for (const path of [
			"/tmp",
			"../other",
			"src/../../other",
			".git/config",
			"src/.git",
			"src\\other",
			"src\0other",
		]) {
			await expect(
				executeInspectionTool(tools.list_files, { path }),
			).rejects.toThrow();
			await expect(
				executeInspectionTool(tools.search_files, { query: "secret", path }),
			).rejects.toThrow();
		}
		expect(commands).toEqual([]);
	});
});
