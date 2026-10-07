import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import type { AgentSessionRecord } from "#/server/adapters/agent-sessions";
import { runAgentTaskTool } from "#/server/services/harness-workspace-session";
import type { WorkspaceMachines } from "#/server/services/workspace-machines";

const fake = vi.hoisted(() => ({
	descendants: vi.fn(),
	queue: vi.fn(),
	capture: vi.fn(),
	accept: vi.fn(),
}));
vi.mock("#/server/adapters/agent-task-command-receipts", async (original) => ({
	...(await original<
		typeof import("#/server/adapters/agent-task-command-receipts")
	>()),
	assignedTaskVerification: vi.fn(async () => null),
	isServerControlledIntegration: vi.fn(async () => false),
}));
vi.mock("#/server/adapters/agent-sessions", () => ({
	descendantAgentSessions: fake.descendants,
}));
vi.mock("#/server/services/agent-peer-messaging", () => ({
	queueAgentPeerMessage: fake.queue,
}));
vi.mock("#/server/adapters/task-patch-evidence", () => ({
	acceptTaskPatch: fake.accept,
}));
vi.mock("#/server/services/reviewed-task-import", () => ({
	captureTaskPatch: fake.capture,
	importReviewedTaskChanges: vi.fn(),
}));
vi.mock("#/server/services/session-workspace-machines", () => ({
	machinesForAgentSession: (machines: unknown) => machines,
}));

it("accepts only the writable patch hash the lead actually inspected", async () => {
	const parent = {
		id: "lead",
		userId: "owner",
		projectId: "project",
		harness: "codex",
	} as AgentSessionRecord;
	fake.descendants.mockResolvedValue([
		{
			id: "child",
			parentSessionId: "lead",
			taskAccess: "read_write",
			taskState: "done",
			providerRef: "vm",
		},
	]);
	fake.capture
		.mockReset()
		.mockResolvedValue({ sha256: "a".repeat(64), base: "b".repeat(40) });
	fake.accept.mockReset().mockResolvedValue(undefined);
	const review = (hash: string) =>
		Effect.runPromise(
			runAgentTaskTool(
				{} as WorkspaceMachines,
				{
					userId: "owner",
					projectId: "project",
					sessionId: "lead",
					harnessId: "codex",
				},
				parent,
				{
					id: "review",
					tool: "mark_task_reviewed",
					arguments: { taskId: "child", expectedSha256: hash },
				},
			),
		);
	await expect(review("")).rejects.toThrow("exact patch hash");
	expect(fake.capture).not.toHaveBeenCalled();
	await expect(review("c".repeat(64))).rejects.toThrow(
		"changed after inspection",
	);
	expect(fake.accept).not.toHaveBeenCalled();
	await expect(review("a".repeat(64))).resolves.toMatchObject({
		reviewState: "reviewed",
		sha256: "a".repeat(64),
	});
	expect(fake.accept).toHaveBeenCalledWith("owner", "lead", {
		taskId: "child",
		sha256: "a".repeat(64),
		base: "b".repeat(40),
	});
});

it("stages leader guidance for an active child without starting a second turn", async () => {
	const parent = {
		id: "lead",
		userId: "owner",
		projectId: "project",
		harness: "codex",
		taskAccess: null,
	} as AgentSessionRecord;
	fake.descendants.mockResolvedValue([
		{ id: "child", title: "Implement parser", turnStatus: "running" },
	]);
	fake.queue.mockResolvedValue({ taskId: "child", status: "queued" });
	expect(
		await Effect.runPromise(
			runAgentTaskTool(
				{} as WorkspaceMachines,
				{
					userId: "owner",
					projectId: "project",
					sessionId: "lead",
					harnessId: "codex",
				},
				parent,
				{
					id: "guidance",
					tool: "send_task_message",
					arguments: {
						taskId: "child",
						message: "Please summarize your progress.",
					},
				},
			),
		),
	).toEqual({ taskId: "child", status: "queued" });
	expect(fake.queue).toHaveBeenCalledWith(
		parent,
		"child",
		"Please summarize your progress.",
		"guidance",
	);
});
