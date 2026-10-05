import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import type { AgentSessionRecord } from "#/server/adapters/agent-sessions";
import { runAgentTaskTool } from "#/server/services/harness-workspace-session";
import type { WorkspaceMachines } from "#/server/services/workspace-machines";

const fake = vi.hoisted(() => ({ descendants: vi.fn(), queue: vi.fn() }));
vi.mock("#/server/adapters/agent-sessions", () => ({
	descendantAgentSessions: fake.descendants,
}));
vi.mock("#/server/services/agent-peer-messaging", () => ({
	queueAgentPeerMessage: fake.queue,
}));

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
