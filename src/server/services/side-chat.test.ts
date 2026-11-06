import { Effect } from "effect";
import { beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceMachines } from "./workspace-machines";

const mocks = vi.hoisted(() => ({
	parent: vi.fn(),
	find: vi.fn(),
	insert: vi.fn(),
	saveSpec: vi.fn(),
	saveState: vi.fn(),
	remove: vi.fn(),
	queue: vi.fn(),
	send: vi.fn(),
	stop: vi.fn(),
	view: vi.fn(),
	withQueued: vi.fn(async (session: unknown) => session),
}));

vi.mock("../adapters/agent-sessions", () => ({
	agentSessionForOwner: mocks.parent,
	agentSessionMetadataForOwner: mocks.parent,
	sideChatForParent: mocks.find,
	insertAgentSession: mocks.insert,
	saveAgentTaskState: mocks.saveState,
	deleteAgentSessionForOwner: mocks.remove,
}));
vi.mock("../adapters/subagents", () => ({ saveSubagentSpec: mocks.saveSpec }));
vi.mock("../adapters/queued-user-messages", () => ({
	queueUserMessageWhileRunning: mocks.queue,
}));
vi.mock("./harness-workspace-session", () => ({
	sendHarnessWorkspaceTask: mocks.send,
	stopHarnessWorkspaceTurn: mocks.stop,
}));
vi.mock("./queued-user-messages", () => ({
	publicSessionView: mocks.view,
	withQueuedMessages: mocks.withQueued,
}));

const { sendSideChatMessage } = await import("./side-chat");

const machines = {} as WorkspaceMachines;
const messageId = "11111111-1111-4111-8111-111111111111";
const parent = {
	id: "parent",
	userId: "owner",
	projectId: "project",
	workspaceId: "workspace",
	parentSessionId: null,
	turnStatus: "running",
	harness: "api",
	items: [{ kind: "agentMessage", id: "agent", text: "Editing auth.ts" }],
};

beforeEach(() => {
	for (const mock of Object.values(mocks)) mock.mockReset();
	mocks.parent.mockResolvedValue(parent);
	mocks.withQueued.mockImplementation(async (session) => session);
	mocks.view.mockResolvedValue({
		agentSessionId: "side",
		items: [],
		turnStatus: "running",
	});
	mocks.send.mockReturnValue(
		Effect.succeed({
			agentSessionId: "side",
			items: [],
			turnStatus: "running",
		}),
	);
	mocks.queue.mockResolvedValue("queued");
	mocks.saveSpec.mockResolvedValue(undefined);
	mocks.saveState.mockResolvedValue(null);
});

function send(text = "what is Main doing?") {
	return sendSideChatMessage(machines, {
		userId: "owner",
		projectId: "project",
		parentSessionId: "parent",
		harnessId: "api",
		modelId: "model",
		text,
		idempotencyKey: messageId,
	});
}

it("starts a side turn while Main is running and does not queue or stop Main", async () => {
	mocks.find.mockResolvedValue(null);
	mocks.insert.mockResolvedValue({
		id: "side",
		userId: "owner",
		turnStatus: "idle",
		parentSessionId: "parent",
	});
	await send();
	expect(mocks.stop).not.toHaveBeenCalled();
	expect(mocks.queue).not.toHaveBeenCalled();
	expect(mocks.send).toHaveBeenCalledTimes(1);
	const scope = mocks.send.mock.calls[0]?.[1];
	const body = mocks.send.mock.calls[0]?.[2];
	expect(scope.sessionId).toBe("side");
	expect(scope.sessionId).not.toBe("parent");
	expect(body.runtimeText).toContain("Editing auth.ts");
	expect(body.runtimeText).toContain("what is Main doing?");
	expect(body.text).toBe("what is Main doing?");
});

it("queues a follow-up on the side chat, not on Main's running turn", async () => {
	mocks.find.mockResolvedValue({
		id: "side",
		userId: "owner",
		turnStatus: "running",
		parentSessionId: "parent",
		agentBudget: { sideChat: true },
	});
	await send("keep going");
	expect(mocks.stop).not.toHaveBeenCalled();
	expect(mocks.send).not.toHaveBeenCalled();
	expect(mocks.queue).toHaveBeenCalledTimes(1);
	expect(mocks.queue.mock.calls[0]?.[0]).toBe("owner");
	expect(mocks.queue.mock.calls[0]?.[1]).toBe("side");
	expect(mocks.queue.mock.calls[0]?.[1]).not.toBe("parent");
	expect(mocks.queue.mock.calls[0]?.[2].message).toContain("Editing auth.ts");
	expect(mocks.queue.mock.calls[0]?.[2].item.text).toBe("keep going");
});
