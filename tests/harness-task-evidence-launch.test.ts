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
	checks: vi.fn(),
	retained: vi.fn(),
	patch: vi.fn(),
	completion: vi.fn(),
}));
vi.mock("#/server/adapters/turn-verification", () => ({
	findCompletedVerification: fake.completion,
}));
vi.mock("#/server/adapters/agent-task-command-receipts", async (original) => ({
	...(await original<
		typeof import("#/server/adapters/agent-task-command-receipts")
	>()),
	retainedTaskCheckResults: fake.retained,
}));
vi.mock("#/server/services/task-output-evidence", async (original) => ({
	...(await original<
		typeof import("#/server/services/task-output-evidence")
	>()),
	readAuthorizedTaskChecks: fake.checks,
}));
vi.mock("#/server/services/reviewed-task-import", async (original) => ({
	...(await original<
		typeof import("#/server/services/reviewed-task-import")
	>()),
	captureTaskPatch: fake.patch,
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
beforeEach(async () => {
	vi.resetAllMocks();
	fake.descendants.mockResolvedValue([child]);
	fake.open.mockResolvedValue(child);
	fake.prepare.mockResolvedValue({ task: child, predecessor: null });
	fake.send.mockResolvedValue(undefined);
	fake.owner.mockResolvedValue(child);
	fake.state.mockResolvedValue(undefined);
	fake.retained.mockResolvedValue(new Map());
	fake.completion.mockResolvedValue(null);
	fake.checks.mockImplementation(
		(
			await vi.importActual<
				typeof import("#/server/services/task-output-evidence")
			>("#/server/services/task-output-evidence")
		).readAuthorizedTaskChecks,
	);
	fake.patch.mockImplementation(
		(
			await vi.importActual<
				typeof import("#/server/services/reviewed-task-import")
			>("#/server/services/reviewed-task-import")
		).captureTaskPatch,
	);
});
const call = (
	tool:
		| "create_task"
		| "read_task_output"
		| "read_task_summary"
		| "read_task_handoff"
		| "mark_task_reviewed"
		| "start_task"
		| "send_task_message"
		| "request_task_wrap_up"
		| "edit_task",
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

it("reads the complete latest child handoff without waking a model or requiring a VM", async () => {
	const summary = `${"x".repeat(4000)}exact receipt reference`;
	fake.descendants.mockResolvedValue([
		{
			...child,
			taskState: "done",
			taskSummary: "Short status preview",
			items: [{ kind: "agentMessage", id: "final", text: summary }],
		},
	]);
	await expect(call("read_task_summary", { taskId: "child" })).resolves.toEqual(
		{
			taskId: "child",
			state: "done",
			capabilities: { commandExecution: false, workspaceEdits: false },
			content: "x".repeat(4000),
			start: 0,
			nextStart: 4000,
		},
	);
	await expect(
		call("read_task_summary", { taskId: "child", start: 4000 }),
	).resolves.toMatchObject({
		content: "exact receipt reference",
		nextStart: null,
	});
	await expect(
		call("read_task_summary", { taskId: "unrelated" }),
	).rejects.toThrow("descendant task");
	await expect(
		call("read_task_summary", { taskId: "child" }, undefined, "foreign"),
	).rejects.toThrow("not available in this project");
	expect(fake.prepare).not.toHaveBeenCalled();
	expect(fake.send).not.toHaveBeenCalled();
});

it("rejects a mismatched descendant owner or project before exposing its summary", async () => {
	for (const foreign of [
		{ ...child, userId: "foreign" },
		{ ...child, projectId: "unrelated-project" },
	]) {
		fake.descendants.mockResolvedValue([
			{ ...foreign, taskSummary: "Private result" },
		]);
		await expect(
			call("read_task_summary", { taskId: "child" }),
		).rejects.toThrow("summary is not available in this project");
	}
});

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

it.each(["failed", "stale", "unbound"])(
	"rejects %s supplied verification before accepting a writer",
	async (failure) => {
		fake.descendants.mockResolvedValue([
			{
				...child,
				taskState: "done",
				taskAccess: "read_write",
				providerRef: "child-vm",
			},
		]);
		const source = {
			revision: "a".repeat(40),
			dirty: true,
			sources: [{ path: "source.ts", sha256: "b".repeat(64) }],
		};
		const reference = "631bb044-cf28-4409-8aab-dceeb230f24a";
		const exec = vi
			.fn()
			.mockResolvedValueOnce({
				exitCode: 0,
				stdout: JSON.stringify([
					{
						stdout: {
							reference,
							content: "check output",
							completion: {
								status: failure === "failed" ? 1 : 0,
								stopped: null,
							},
							...(failure === "unbound"
								? {}
								: {
										verification: {
											command: "test",
											cwd: "/repo",
											before: source,
											after: source,
											sourcesStable: true,
										},
									}),
						},
						stderr: {
							reference,
							content: "",
							completion: {
								status: failure === "failed" ? 1 : 0,
								stopped: null,
							},
							...(failure === "unbound"
								? {}
								: {
										verification: {
											command: "test",
											cwd: "/repo",
											before: source,
											after: source,
											sourcesStable: true,
										},
									}),
						},
					},
				]),
			})
			.mockResolvedValueOnce({
				exitCode: 0,
				stdout: JSON.stringify(
					failure === "stale"
						? {
								...source,
								sources: [{ path: "source.ts", sha256: "c".repeat(64) }],
							}
						: source,
				),
			});
		await expect(
			call(
				"mark_task_reviewed",
				{
					taskId: "child",
					expectedSha256: "d".repeat(64),
					verificationReferences: [reference],
				},
				{ exec, ensureRunning: vi.fn() } as unknown as WorkspaceMachines,
			),
		).rejects.toThrow("current unchanged declared sources");
		expect(fake.send).not.toHaveBeenCalled();
		expect(exec).toHaveBeenCalledTimes(failure === "unbound" ? 1 : 2);
	},
);

it("retrieves a completed handoff and durable check references in one read without inference", async () => {
	const reference = "00000000-0000-4000-8000-000000000001";
	const receipt = [{ command: "test", reference, exitCode: 0, stopped: null }];
	fake.descendants.mockResolvedValue([
		{
			...child,
			taskState: "done",
			turnStatus: "completed",
			providerRef: "vm-123",
			taskSummary: "Implemented",
			items: [
				{
					kind: "dynamicToolCall",
					id: "turn:check",
					tool: "run_checks",
					status: "completed",
					output: "clipped UI output",
				},
			],
		},
	]);
	fake.retained.mockResolvedValue(new Map([["turn:check", receipt]]));
	fake.patch.mockResolvedValue({
		base: "base",
		sha256: "a".repeat(64),
		bytes: Buffer.from("patch"),
	});
	fake.checks.mockResolvedValue({
		checks: [{ reference, completion: { status: 0, stopped: null } }],
		sourceProofs: [],
	});
	const completionVerification = {
		type: "completion-verification",
		directory: "/repo",
		turn: "b".repeat(64),
		base: "base",
		tree: "d".repeat(40),
		patchSha256: "a".repeat(64),
		checks: receipt,
	};
	fake.completion.mockResolvedValue(completionVerification);
	const machines = {
		ensureRunning: vi.fn(async () => {}),
		readTextFile: vi.fn(async () => "/repo"),
	} as unknown as WorkspaceMachines;
	await expect(
		call("read_task_handoff", { taskId: "child" }, machines),
	).resolves.toMatchObject({
		taskId: "child",
		verificationReferences: [reference],
		remainingReferences: [],
		discoveryIncomplete: false,
		summary: { content: "Implemented" },
		completionVerification,
	});
	expect(fake.completion).toHaveBeenCalledWith("owner", "child", "/repo", {
		base: "base",
		patchSha256: "a".repeat(64),
	});
	expect(fake.retained).toHaveBeenCalledWith({
		userId: "owner",
		projectId: "project",
		sessionId: "child",
		requestIds: ["turn:check"],
	});
	expect(fake.checks).toHaveBeenCalledWith(
		expect.objectContaining({
			references: [reference],
			ownerId: "owner",
			projectId: "project",
		}),
	);
	expect(fake.prepare).not.toHaveBeenCalled();
	expect(fake.send).not.toHaveBeenCalled();
});

it("rejects foreign, incomplete and unrelated handoffs before any evidence or VM access", async () => {
	await expect(call("read_task_handoff", { taskId: "child" })).rejects.toThrow(
		"completed task",
	);
	fake.descendants.mockResolvedValue([
		{ ...child, userId: "someone-else", taskState: "done" },
	]);
	await expect(call("read_task_handoff", { taskId: "child" })).rejects.toThrow(
		"not available in this project",
	);
	await expect(
		call("read_task_handoff", { taskId: "unrelated" }),
	).rejects.toThrow("descendant task");
	expect(fake.retained).not.toHaveBeenCalled();
	expect(fake.checks).not.toHaveBeenCalled();
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
