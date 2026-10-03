import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import { apiAgentTools } from "./api-agent-tools";
import type { WorkspaceMachines } from "./workspace-machines";

vi.mock("../adapters/agent-task-command-receipts", () => ({
	claimAgentTaskCommand: vi.fn(async () => ({ kind: "claimed" })),
	completeAgentTaskCommand: vi.fn(),
	renewAgentTaskCommandClaim: vi.fn(),
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

function leadTools() {
	const commands: string[] = [];
	const machines = {
		exec: async (_vm: string, command: string) => {
			commands.push(command);
			return { exitCode: 0, stdout: "README.md\n", stderr: "" };
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
			"browser_click",
			"browser_type",
			"browser_key",
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
			"git -C '/workspace/repo' ls-files --cached --others --exclude-standard",
			"git -C '/workspace/repo' grep -n -I -m 5 -e 'task' -- .",
		]);
	});

	it("quotes search input so it cannot become another command", async () => {
		const { commands, tools } = leadTools();
		await executeInspectionTool(tools.search_files, {
			query: "a'; touch /tmp/unwanted; echo 'b",
		});
		expect(commands[0]).toContain("'a'\\''; touch /tmp/unwanted; echo '\\''b'");
	});
});
