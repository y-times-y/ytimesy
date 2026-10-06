import { createHash } from "node:crypto";
import { Effect } from "effect";
import { beforeEach, expect, it, vi } from "vitest";
import type { AgentSessionRecord } from "#/server/adapters/agent-sessions";
import { runAgentTaskTool } from "#/server/services/harness-workspace-session";
import type { WorkspaceMachines } from "#/server/services/workspace-machines";

const fake = vi.hoisted(() => ({
	descendants: vi.fn(),
	open: vi.fn(),
	prepare: vi.fn(),
	send: vi.fn(),
	owner: vi.fn(),
	state: vi.fn(),
}));
vi.mock("#/server/adapters/agent-sessions", () => ({
	descendantAgentSessions: fake.descendants,
	agentSessionForOwner: fake.owner,
	saveAgentTaskState: fake.state,
}));
vi.mock("#/server/services/agent-session-machine", () => ({
	openAgentTask: fake.open,
	prepareAgentTaskStart: fake.prepare,
}));
vi.mock("#/server/services/api-workspace-session", () => ({
	sendApiWorkspaceTask: fake.send,
}));
const parent = {
	id: "lead",
	userId: "owner",
	projectId: "project",
	harness: "api",
	listedModelId: "model",
} as AgentSessionRecord;
const child = {
	id: "child",
	userId: "owner",
	projectId: "project",
	parentSessionId: "lead",
	harness: "api",
	listedModelId: "model",
	taskPlacement: "fresh",
	taskExecution: "parallel",
	taskPrompt: "Implement the bounded contract",
	taskState: "draft",
	providerRef: null,
} as AgentSessionRecord;
beforeEach(() => {
	vi.resetAllMocks();
	fake.descendants.mockResolvedValue([child]);
	fake.open.mockResolvedValue(child);
	fake.prepare.mockResolvedValue({ task: child, predecessor: null });
	fake.send.mockResolvedValue(undefined);
	fake.owner.mockResolvedValue(child);
	fake.state.mockResolvedValue(undefined);
});
const call = (
	tool: "create_task" | "read_task_output",
	args: Record<string, unknown>,
	machines = {} as WorkspaceMachines,
	userId = "owner",
) =>
	Effect.runPromise(
		runAgentTaskTool(
			machines,
			{ userId, projectId: "project", sessionId: "lead", harnessId: "api" },
			parent,
			{ id: "call", tool, arguments: args },
		),
	);

it("keeps ordinary creation draft-only and launches a complete ready draft through normal admission when requested", async () => {
	const args = {
		title: "Implement policy",
		prompt: "Implement the bounded contract",
	};
	await expect(call("create_task", args)).resolves.toMatchObject({
		taskId: "child",
		status: "draft",
	});
	expect(fake.prepare).not.toHaveBeenCalled();
	expect(fake.send).not.toHaveBeenCalled();
	await expect(
		call("create_task", { ...args, startImmediately: true }),
	).resolves.toMatchObject({
		taskId: "child",
		status: "working",
		machineId: null,
	});
	expect(fake.prepare).toHaveBeenCalledExactlyOnceWith({
		userId: "owner",
		projectId: "project",
		taskSessionId: "child",
	});
	expect(fake.send).toHaveBeenCalledOnce();
});

it("returns the original task and observed state after admission or dispatch failure instead of silently making a replacement", async () => {
	fake.prepare.mockRejectedValueOnce(new Error("private admission detail"));
	const args = {
		title: "Implement policy",
		prompt: "Implement the bounded contract",
		startImmediately: true,
	};
	const rejected = await call("create_task", args);
	expect(rejected).toMatchObject({
		taskId: "child",
		status: "draft",
		startError: expect.stringContaining("inspect capacity"),
	});
	expect(JSON.stringify(rejected)).not.toContain("private admission detail");
	expect(fake.open).toHaveBeenCalledOnce();
	expect(fake.send).not.toHaveBeenCalled();
	fake.owner.mockResolvedValueOnce({ ...child, taskState: "failed" });
	fake.send.mockRejectedValueOnce(new Error("private dispatch detail"));
	await expect(call("create_task", args)).resolves.toMatchObject({
		taskId: "child",
		status: "failed",
	});
});

it("rejects invalid launch flags before creating any draft", async () => {
	await expect(
		call("create_task", {
			title: "Policy",
			prompt: "Contract",
			startImmediately: "true",
		}),
	).rejects.toThrow("must be a boolean");
	expect(fake.open).not.toHaveBeenCalled();
});

it("reads evidence from the authorized child's artifact namespace, not the lead's", async () => {
	fake.descendants.mockResolvedValue([{ ...child, providerRef: "child-vm" }]);
	const exec = vi.fn().mockResolvedValue({
		exitCode: 0,
		stdout: JSON.stringify({
			reference: "631bb044-cf28-4409-8aab-dceeb230f24a",
			content: "All required checks passed",
			nextStart: null,
		}),
	});
	const machines = {
		exec,
		ensureRunning: vi.fn().mockResolvedValue(undefined),
	} as unknown as WorkspaceMachines;
	await expect(
		call(
			"read_task_output",
			{ taskId: "child", reference: "631bb044-cf28-4409-8aab-dceeb230f24a" },
			machines,
		),
	).resolves.toMatchObject({ content: "All required checks passed" });
	expect(exec.mock.calls[0][0]).toBe("child-vm");
	expect(exec.mock.calls[0][1]).toContain(
		createHash("sha256").update("child").digest("hex"),
	);
	expect(exec.mock.calls[0][1]).not.toContain(
		createHash("sha256").update("lead").digest("hex"),
	);
});

it("rejects unrelated tasks and foreign owners before reading any guest evidence", async () => {
	const exec = vi.fn();
	const machines = { exec } as unknown as WorkspaceMachines;
	await expect(
		call(
			"read_task_output",
			{
				taskId: "unrelated",
				reference: "631bb044-cf28-4409-8aab-dceeb230f24a",
			},
			machines,
		),
	).rejects.toThrow("descendant task");
	await expect(
		call(
			"read_task_output",
			{ taskId: "child", reference: "631bb044-cf28-4409-8aab-dceeb230f24a" },
			machines,
			"foreign",
		),
	).rejects.toThrow("not available in this project");
	expect(exec).not.toHaveBeenCalled();
});

it("includes independently observed background completion and rejects malformed evidence references", async () => {
	fake.descendants.mockResolvedValue([{ ...child, providerRef: "child-vm" }]);
	const reference = "631bb044-cf28-4409-8aab-dceeb230f24a";
	const exec = vi
		.fn()
		.mockResolvedValueOnce({
			exitCode: 0,
			stdout: JSON.stringify({ reference, content: "Done", nextStart: null }),
		})
		.mockResolvedValueOnce({
			exitCode: 0,
			stdout: JSON.stringify([{ id: reference, status: 0, stopped: null }]),
		});
	const machines = {
		exec,
		ensureRunning: vi.fn().mockResolvedValue(undefined),
	} as unknown as WorkspaceMachines;
	await expect(
		call(
			"read_task_output",
			{ taskId: "child", reference, background: true },
			machines,
		),
	).resolves.toMatchObject({ completion: { status: 0, stopped: null } });
	expect(exec).toHaveBeenCalledTimes(2);
	exec.mockClear();
	await expect(
		call(
			"read_task_output",
			{ taskId: "child", reference: "../../private" },
			machines,
		),
	).rejects.toThrow();
	expect(exec).not.toHaveBeenCalled();
});
