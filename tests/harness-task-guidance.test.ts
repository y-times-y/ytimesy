import { Effect } from "effect";
import { beforeEach, expect, it, vi } from "vitest";
import type { AgentSessionRecord } from "#/server/adapters/agent-sessions";
import { runAgentTaskTool } from "#/server/services/harness-workspace-session";
import type { WorkspaceMachines } from "#/server/services/workspace-machines";

const fake = vi.hoisted(() => ({
	descendants: vi.fn(),
	queue: vi.fn(),
	capture: vi.fn(),
	accept: vi.fn(),
	send: vi.fn(),
	owner: vi.fn(),
	activeTurn: vi.fn(async () => false),
}));
vi.mock("#/server/adapters/api-turns", () => ({
	hasActiveApiTurn: fake.activeTurn,
}));
beforeEach(() => fake.activeTurn.mockReset().mockResolvedValue(false));
vi.mock("#/server/services/session-branch", () => ({
	commitChatBranchForSubmission: vi.fn(async () => {}),
}));
vi.mock("#/server/services/codex-subscription-session", () => ({
	sendSubscriptionTask: fake.send,
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
	agentSessionForOwner: fake.owner,
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

it.each(["running", "idle"])(
	"stages guidance for an active child whose visible status is %s",
	async (turnStatus) => {
		const parent = {
			id: "lead",
			userId: "owner",
			projectId: "project",
			harness: "codex",
			taskAccess: null,
		} as AgentSessionRecord;
		fake.descendants.mockResolvedValue([
			{
				id: "child",
				title: "Implement parser",
				turnStatus,
				taskState: "waiting",
				harness: "codex",
			},
		]);
		fake.activeTurn.mockResolvedValueOnce(true);
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
	},
);

it("rejects command-dependent guidance to a cloud read-only child before queuing or waking it", async () => {
	fake.queue.mockClear();
	fake.descendants.mockResolvedValue([
		{
			id: "child",
			harness: "codex",
			parentSessionId: "lead",
			taskAccess: "read_only",
			taskState: "done",
			turnStatus: "idle",
		},
	]);
	await expect(
		Effect.runPromise(
			runAgentTaskTool(
				{} as WorkspaceMachines,
				{
					userId: "owner",
					projectId: "project",
					sessionId: "lead",
					harnessId: "codex",
				},
				{
					id: "lead",
					harness: "codex",
					userId: "owner",
					projectId: "project",
				} as AgentSessionRecord,
				{
					id: "diagnostic",
					tool: "send_task_message",
					arguments: {
						taskId: "child",
						message: "Run a diagnostic.",
						requiresCommandExecution: true,
					},
				},
			),
		),
	).rejects.toThrow("cannot execute commands");
	expect(fake.queue).not.toHaveBeenCalled();
});

it("returns a completed child's retained summary without waking it for an ordinary message", async () => {
	fake.queue.mockClear();
	fake.descendants.mockResolvedValue([
		{
			id: "child",
			harness: "codex",
			parentSessionId: "lead",
			taskAccess: "read_only",
			taskState: "done",
			turnStatus: "idle",
			items: [
				{ id: "result", kind: "agentMessage", text: "Source review complete." },
			],
		},
	]);
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
				{
					id: "lead",
					harness: "codex",
					userId: "owner",
					projectId: "project",
				} as AgentSessionRecord,
				{
					id: "summary",
					tool: "send_task_message",
					arguments: { taskId: "child", message: "Summarize." },
				},
			),
		),
	).toMatchObject({
		status: "completed",
		delivered: false,
		content: "Source review complete.",
	});
	expect(fake.queue).not.toHaveBeenCalled();
});

it("can explicitly resume a completed child for new authorized work", async () => {
	fake.send
		.mockReset()
		.mockResolvedValue({ connection: { status: "connected" } });
	fake.owner.mockResolvedValue({ harness: "codex" });
	fake.descendants.mockResolvedValue([
		{
			id: "child",
			harness: "codex",
			parentSessionId: "lead",
			listedModelId: "model",
			taskAccess: "read_only",
			taskState: "done",
			turnStatus: "idle",
		},
	]);
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
				{
					id: "lead",
					harness: "codex",
					userId: "owner",
					projectId: "project",
				} as AgentSessionRecord,
				{
					id: "followup",
					tool: "send_task_message",
					arguments: {
						taskId: "child",
						message: "Inspect the newly changed source.",
						resumeCompleted: true,
					},
				},
			),
		),
	).toMatchObject({ status: "working" });
	expect(fake.send).toHaveBeenCalledWith(
		expect.objectContaining({ sessionId: "child" }),
		expect.objectContaining({ text: "Inspect the newly changed source." }),
	);
});

it("allows command-dependent guidance to an active writable child", async () => {
	fake.queue.mockReset().mockResolvedValue({ delivered: true });
	fake.descendants.mockResolvedValue([
		{
			id: "child",
			harness: "codex",
			parentSessionId: "lead",
			taskAccess: "read_write",
			taskState: "working",
			turnStatus: "running",
		},
	]);
	await Effect.runPromise(
		runAgentTaskTool(
			{} as WorkspaceMachines,
			{
				userId: "owner",
				projectId: "project",
				sessionId: "lead",
				harnessId: "codex",
			},
			{
				id: "lead",
				harness: "codex",
				userId: "owner",
				projectId: "project",
			} as AgentSessionRecord,
			{
				id: "diagnostic",
				tool: "send_task_message",
				arguments: {
					taskId: "child",
					message: "Run the required tests.",
					requiresCommandExecution: true,
				},
			},
		),
	);
	expect(fake.queue).toHaveBeenCalledOnce();
});

it("reports a failed explicit resume rather than claiming the child is working", async () => {
	fake.owner.mockResolvedValue({ harness: "codex" });
	fake.send.mockResolvedValue({
		connection: { status: "failed", message: "Connection expired." },
	});
	fake.descendants.mockResolvedValue([
		{
			id: "child",
			harness: "codex",
			parentSessionId: "lead",
			listedModelId: "model",
			taskAccess: "read_only",
			taskState: "done",
			turnStatus: "idle",
		},
	]);
	await expect(
		Effect.runPromise(
			runAgentTaskTool(
				{} as WorkspaceMachines,
				{
					userId: "owner",
					projectId: "project",
					sessionId: "lead",
					harnessId: "codex",
				},
				{
					id: "lead",
					harness: "codex",
					userId: "owner",
					projectId: "project",
				} as AgentSessionRecord,
				{
					id: "followup",
					tool: "send_task_message",
					arguments: {
						taskId: "child",
						message: "Inspect the new source.",
						resumeCompleted: true,
					},
				},
			),
		),
	).rejects.toThrow("Connection expired.");
});
