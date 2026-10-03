import { beforeEach, expect, it, vi } from "vitest";
import type { ApiTurn } from "../adapters/api-turns";
import type { WorkspaceMachines } from "../services/workspace-machines";
import { runApiTurn } from "./api-turn";

const mocks = vi.hoisted(() => ({
	renew: vi.fn(),
	finalize: vi.fn(),
	stop: vi.fn(),
	runtime: vi.fn(),
	result: vi.fn(),
	enqueue: vi.fn(),
	owner: vi.fn(),
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
vi.mock("../auth/codex-managed-auth", () => ({ hasManagedCodexAuth: vi.fn() }));
vi.mock("../services/api-agent-runtime", () => ({
	runApiAgent: mocks.runtime,
}));
vi.mock("../services/codex-subscription-agent", () => ({
	runCodexSubscriptionAgent: vi.fn(),
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
