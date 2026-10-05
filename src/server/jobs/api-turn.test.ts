import { beforeEach, expect, it, vi } from "vitest";
import { SessionItemId } from "#/domain/ids";
import { subscriptionTurnRevision } from "#/domain/subscription-turn";
import type { ApiTurn } from "../adapters/api-turns";
import type { WorkspaceMachines } from "../services/workspace-machines";
import { runApiTurn } from "./api-turn";

const mocks = vi.hoisted(() => ({
	renew: vi.fn(),
	finalize: vi.fn(),
	stop: vi.fn(),
	runtime: vi.fn(),
	stepRuntime: vi.fn(),
	result: vi.fn(),
	enqueue: vi.fn(),
	owner: vi.fn(),
	knowledge: vi.fn(),
	report: vi.fn(),
	subscriptionRuntime: vi.fn(),
	auth: vi.fn(),
}));
vi.mock("../services/project-knowledge", () => ({
	loadCloudProjectKnowledge: mocks.knowledge,
	recordCloudProjectReport: mocks.report,
}));
vi.mock("../adapters/api-turns", () => ({
	renewApiTurn: mocks.renew,
	finalizeApiTurn: mocks.finalize,
	checkpointApiTurn: vi.fn(),
	publishApiTurnProgress: vi.fn(),
}));
vi.mock("../adapters/conversation-turn-control", () => ({
	coordinateConversationTurn: vi.fn(async () => true),
}));
vi.mock("../adapters/agent-sessions", () => ({
	agentSessionForOwner: mocks.owner,
}));
beforeEach(() => {
	vi.clearAllMocks();
	mocks.knowledge.mockResolvedValue(
		"## Existing capabilities\nBranch selection is implemented in branch.ts.",
	);
	mocks.report.mockResolvedValue(undefined);
	mocks.auth.mockResolvedValue(true);
	mocks.owner.mockResolvedValue({
		id: "session",
		userId: "owner",
		projectId: "project",
		harness: "api",
		taskAccess: "read_write",
	});
	mocks.renew.mockReset().mockResolvedValue(true);
	mocks.finalize.mockImplementation(async (_turn, state) => state);
	mocks.result.mockResolvedValue("event");
	mocks.enqueue.mockResolvedValue("job");
});
vi.mock("../adapters/model-connections", () => ({
	loadModelConnection: vi.fn(async () => ({ revision: "revision" })),
}));
vi.mock("../adapters/agent-task-events", () => ({
	saveAgentTaskResultAndEvent: mocks.result,
}));
vi.mock("./queue", () => ({ enqueueAgentTaskEvent: mocks.enqueue }));
vi.mock("../adapters/server-peer-inbox", () => ({
	injectServerPeerMessages: vi.fn(),
}));
vi.mock("../adapters/api-usage-budget", () => ({ reserveApiTokens: vi.fn() }));
vi.mock("../auth/codex-managed-auth", () => ({
	hasManagedCodexAuth: mocks.auth,
}));
vi.mock("../services/api-agent-runtime", () => ({
	runApiAgent: mocks.runtime,
	runApiAgentStep: mocks.stepRuntime,
}));
vi.mock("../services/codex-subscription-agent", () => ({
	runCodexSubscriptionAgent: mocks.subscriptionRuntime,
	runCodexSubscriptionAgentStep: vi.fn(),
}));
vi.mock("../services/api-agent-tools", () => ({
	apiAgentTools: (input: unknown) => input,
}));
vi.mock("../services/api-command-scope", () => ({
	stopApiTurnCommands: mocks.stop,
}));
vi.mock("../services/api-turn-workspace", () => ({
	deferredApiTurnWorkspace: () => async () => ({
		machines: {},
		vm: "vm",
		cwd: "/repo",
	}),
}));
vi.mock("../services/session-workspace-machines", () => ({
	machinesForAgentSession: (machines: unknown) => machines,
}));

it("loads project knowledge into the cloud model instructions without preparing a VM", async () => {
	mocks.runtime.mockImplementation(async (input) => {
		expect(input.instructions).toContain(
			"Branch selection is implemented in branch.ts",
		);
		expect(input.instructions).toContain("historical data");
		await input.onEvent({
			type: "text-delta",
			id: "reply",
			text: "The branch picker already exists.",
		});
		return [];
	});
	const turn = {
		id: "turn",
		session_id: "session",
		user_id: "owner",
		connection_id: "connection",
		connection_revision: "revision",
		model_id: "model",
		state: "running",
		messages: [{ role: "user", content: "Fix branches" }],
		items: [
			{ kind: "userMessage", id: SessionItemId("user"), text: "Fix branches" },
		],
		lease_id: "lease",
	} as ApiTurn;
	expect(await runApiTurn({} as WorkspaceMachines, turn)).toBe("completed");
	expect(mocks.report).toHaveBeenCalledOnce();
	expect(mocks.knowledge).toHaveBeenCalledWith(
		expect.objectContaining({ userId: "owner", projectId: "project" }),
		"Fix branches",
	);
});

it("uses the same project knowledge and completion capture for Codex subscription turns", async () => {
	mocks.subscriptionRuntime.mockImplementation(async (input) => {
		expect(input.instructions).toContain(
			"Branch selection is implemented in branch.ts",
		);
		await input.onEvent({
			type: "text-delta",
			id: "reply",
			text: "The branch picker already exists.",
		});
		return [];
	});
	const turn = {
		id: "turn",
		session_id: "session",
		user_id: "owner",
		connection_id: null,
		connection_revision: subscriptionTurnRevision("medium"),
		model_id: "model",
		state: "running",
		messages: [{ role: "user", content: "Fix branches" }],
		items: [
			{ kind: "userMessage", id: SessionItemId("user"), text: "Fix branches" },
		],
		lease_id: "lease",
	} as ApiTurn;
	expect(await runApiTurn({} as WorkspaceMachines, turn)).toBe("completed");
	expect(mocks.subscriptionRuntime).toHaveBeenCalledOnce();
	expect(mocks.runtime).not.toHaveBeenCalled();
	expect(mocks.report).toHaveBeenCalledOnce();
});

it("stops command groups on abort while the model loop is still awaiting a tool", async () => {
	let finishTool: () => void = () => {
		throw new Error("Tool was not started");
	};
	mocks.renew.mockResolvedValueOnce(true).mockResolvedValue(false);
	mocks.finalize.mockImplementation(async (_turn, state) => state);
	mocks.runtime.mockImplementation(async (input) => {
		await input.tools.workspace();
		await new Promise<void>((resolve) => {
			finishTool = resolve;
		});
	});
	mocks.stop.mockImplementation(async () => {
		expect(mocks.finalize).not.toHaveBeenCalled();
		finishTool();
	});
	await runApiTurn(
		{} as WorkspaceMachines,
		{
			id: "00000000-0000-4000-8000-000000000001",
			session_id: "session",
			user_id: "owner",
			connection_id: "connection",
			connection_revision: "revision",
			model_id: "model",
			state: "running",
			messages: [],
			items: [],
			lease_id: "00000000-0000-4000-8000-000000000002",
		} as ApiTurn,
	);
	expect(mocks.stop).toHaveBeenCalledTimes(1);
	expect(mocks.finalize).toHaveBeenCalledWith(
		expect.anything(),
		"cancelled",
		expect.anything(),
	);
});

it("classifies heartbeat failures without logging database error details", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.useFakeTimers();
	try {
		const privateError = Object.assign(new Error("secret query credentials"), {
			code: "ECONNRESET",
		});
		mocks.renew.mockResolvedValueOnce(true).mockRejectedValue(privateError);
		mocks.runtime.mockImplementation(async (input) => {
			await new Promise<void>((resolve) => {
				input.signal.addEventListener("abort", () => resolve(), { once: true });
			});
			input.signal.throwIfAborted();
		});
		const run = runApiTurn({} as WorkspaceMachines, childTurn);
		await vi.advanceTimersByTimeAsync(1001);
		await run;
		expect(warn).toHaveBeenCalledWith("Turn heartbeat failed", {
			stage: "database-renewal",
			code: "ECONNRESET",
			name: "Error",
		});
		expect(JSON.stringify(warn.mock.calls)).not.toContain("secret query");
	} finally {
		vi.useRealTimers();
		warn.mockRestore();
	}
});

const childTurn = {
	id: "00000000-0000-4000-8000-000000000001",
	session_id: "session",
	user_id: "owner",
	connection_id: "connection",
	connection_revision: "revision",
	model_id: "model",
	state: "running",
	messages: [],
	items: [],
	lease_id: "00000000-0000-4000-8000-000000000002",
} as ApiTurn;

it("awaits an in-flight heartbeat before the invocation can close its database pool", async () => {
	vi.useFakeTimers();
	try {
		let completeHeartbeat: (alive: boolean) => void = () => {};
		let completeModel: () => void = () => {};
		mocks.renew.mockResolvedValueOnce(true).mockImplementation(
			() =>
				new Promise<boolean>((resolve) => {
					completeHeartbeat = resolve;
				}),
		);
		mocks.runtime.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					completeModel = resolve;
				}),
		);
		let settled = false;
		const run = runApiTurn({} as WorkspaceMachines, childTurn).then(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(1001);
		completeModel();
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).toBe(false);
		completeHeartbeat(true);
		await run;
		expect(settled).toBe(true);
	} finally {
		vi.useRealTimers();
	}
});

it("immediately queues a completed child's parent event", async () => {
	mocks.owner.mockResolvedValue({
		id: "session",
		userId: "owner",
		projectId: "project",
		harness: "api",
		parentSessionId: "parent",
	});
	mocks.runtime.mockImplementation(async (input) =>
		input.onEvent({ type: "text-delta", id: "answer", text: "Done" }),
	);
	await runApiTurn({} as WorkspaceMachines, childTurn);
	expect(mocks.result).toHaveBeenCalledWith(
		expect.objectContaining({ eventType: "completed" }),
	);
	expect(mocks.enqueue).toHaveBeenCalledWith("event");
});

it("saves and queues child failures, including failures before runtime startup", async () => {
	mocks.owner.mockResolvedValue({
		id: "session",
		userId: "owner",
		projectId: "project",
		harness: "api",
		parentSessionId: "parent",
	});
	mocks.runtime.mockRejectedValue(new Error("Model unavailable"));
	await runApiTurn({} as WorkspaceMachines, childTurn);
	expect(mocks.result).toHaveBeenCalledWith(
		expect.objectContaining({ sessionId: "session", eventType: "failed" }),
	);
	expect(mocks.enqueue).toHaveBeenCalledWith("event");
});

it("keeps a durable tool boundary running, preserving cumulative usage and distinct stream IDs", async () => {
	mocks.stepRuntime.mockImplementation(async (input) => {
		await input.onEvent({ type: "text-delta", id: "0", text: "Next step" });
		await input.onEvent({
			type: "usage",
			usage: {
				inputTokens: 3,
				outputTokens: 2,
				uncachedInputTokens: 3,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			},
		});
		await input.onStep([
			{ role: "user", content: "Task" },
			{ role: "assistant", content: "Next step" },
		]);
		return { outcome: "continue", messages: [] };
	});
	const result = await runApiTurn(
		{} as WorkspaceMachines,
		{
			...childTurn,
			items: [
				{
					kind: "userMessage",
					id: SessionItemId("user"),
					text: "Task",
					apiUsage: {
						inputTokens: 10,
						outputTokens: 4,
						uncachedInputTokens: 10,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
					},
				},
			],
		},
		{ index: 2, signal: new AbortController().signal },
	);
	expect(result).toBe("continue");
	expect(mocks.finalize).not.toHaveBeenCalled();
	expect(mocks.result).not.toHaveBeenCalled();
	const { checkpointApiTurn } = await import("../adapters/api-turns");
	expect(checkpointApiTurn).toHaveBeenLastCalledWith(
		expect.anything(),
		expect.anything(),
		expect.arrayContaining([
			expect.objectContaining({
				id: `${childTurn.id}:step-2:0`,
				text: "Next step",
			}),
			expect.objectContaining({
				kind: "userMessage",
				apiUsage: expect.objectContaining({ inputTokens: 13, outputTokens: 6 }),
			}),
		]),
	);
});

it("finishes a bounded step limit without starting inference or publishing a fake success", async () => {
	mocks.stepRuntime.mockClear();
	expect(
		await runApiTurn({} as WorkspaceMachines, childTurn, {
			index: 31,
			signal: new AbortController().signal,
			limitReached: true,
		}),
	).toBe("failed");
	expect(mocks.stepRuntime).not.toHaveBeenCalled();
	expect(mocks.finalize).toHaveBeenCalledWith(
		expect.anything(),
		"failed",
		expect.arrayContaining([
			expect.objectContaining({
				kind: "error",
				message: expect.stringContaining("tool-step limit"),
			}),
		]),
	);
});
