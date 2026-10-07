import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTaskEvent } from "#/server/adapters/agent-task-events";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import {
	deliverParentTaskNotification,
	taskEventMessage,
} from "./agent-task-event-delivery";

const mocks = vi.hoisted(() => ({
	accepted: vi.fn(),
	stage: vi.fn(),
	remove: vi.fn(),
	ack: vi.fn(),
	send: vi.fn(),
	nativeAccepted: vi.fn(),
	nativeStage: vi.fn(),
}));
vi.mock("../adapters/server-peer-inbox", () => ({
	serverPeerMessageAccepted: mocks.accepted,
	stageServerPeerMessage: mocks.stage,
	removePendingServerPeerMessage: mocks.remove,
	acknowledgeServerPeerMessage: mocks.ack,
}));
vi.mock("./harness-workspace-session", () => ({
	sendHarnessWorkspaceTask: mocks.send,
}));
vi.mock("./session-workspace-machines", () => ({
	machinesForAgentSession: (machines: unknown) => machines,
}));
vi.mock("./peer-inbox", () => ({
	PEER_INBOX_PATH: "/tmp/ytimesy-peer-inbox",
	peerMessageAccepted: mocks.nativeAccepted,
	stagePeerMessage: mocks.nativeStage,
}));
beforeEach(() => {
	vi.clearAllMocks();
	mocks.accepted.mockResolvedValue(false);
	mocks.nativeAccepted.mockResolvedValue(false);
	mocks.send.mockReturnValue(
		Effect.succeed({
			connection: { status: "authenticated" },
			turnStatus: "running",
		}),
	);
});

const parent = {
	id: "parent",
	userId: "owner",
	projectId: "project",
	harness: "codex",
	listedModelId: "model",
	turnStatus: "running",
} as AgentSessionRecord;

it("injects notifications into an active server leader without launching a second turn", async () => {
	await expect(
		deliverParentTaskNotification(
			{} as never,
			parent,
			"event-1",
			"Child finished",
		),
	).rejects.toThrow("safe point");
	expect(mocks.stage).toHaveBeenCalledWith(
		"parent",
		"event-1",
		"Child finished",
	);
	expect(mocks.send).not.toHaveBeenCalled();
});
it("does not wake a leader again after safe-point acknowledgement", async () => {
	mocks.accepted.mockResolvedValue(true);
	await deliverParentTaskNotification(
		{} as never,
		{ ...parent, turnStatus: "completed" },
		"event-1",
		"Child finished",
	);
	expect(mocks.send).not.toHaveBeenCalled();
});
it("falls back to one idle wakeup when the active turn ended before consuming its mailbox", async () => {
	await deliverParentTaskNotification(
		{} as never,
		{ ...parent, turnStatus: "completed" },
		"event-1",
		"Child finished",
	);
	expect(mocks.remove).toHaveBeenCalledWith("parent", "event-1");
	expect(mocks.send).toHaveBeenCalledTimes(1);
	expect(mocks.ack).toHaveBeenCalledWith("parent", "event-1");
});
it("uses the native hook mailbox for a running Claude leader", async () => {
	await expect(
		deliverParentTaskNotification(
			{} as never,
			{ ...parent, harness: "claude", providerRef: "vm" },
			"event-1",
			"Child finished",
		),
	).rejects.toThrow("safe point");
	expect(mocks.nativeStage).toHaveBeenCalled();
	expect(mocks.send).not.toHaveBeenCalled();
});
it("bounds long child summaries before staging them in the mailbox", async () => {
	await expect(
		deliverParentTaskNotification(
			{} as never,
			parent,
			"event-1",
			"x".repeat(16000),
		),
	).rejects.toThrow("safe point");
	expect(mocks.stage.mock.calls[0][2].length).toBeLessThan(12000);
	expect(mocks.stage.mock.calls[0][2]).toContain(
		"Read the child's full result",
	);
});

function event(eventType: AgentTaskEvent["eventType"]): AgentTaskEvent {
	return {
		id: "event-1",
		userId: "user-1",
		parentSessionId: "parent-1",
		childSessionId: "child-1",
		eventType,
		payload: { message: "Evidence here" },
		attempts: 1,
	};
}

describe("task event messages", () => {
	it("uses a compact completion signal with retained summary access only for automatic-review roots", () => {
		const message = taskEventMessage(event("completed"), "Audit API", true);
		expect(message).toContain("child-1");
		expect(message).toContain("next model step");
		expect(message).toContain("Completion is not acceptance");
		expect(message).not.toContain("Evidence here");
		expect(taskEventMessage(event("failed"), "Audit API", true)).toContain(
			"Evidence here",
		);
		expect(taskEventMessage(event("blocked"), "Audit API", true)).toContain(
			"Evidence here",
		);
	});
	it("asks the parent to review a completed child", () => {
		expect(taskEventMessage(event("completed"), "Audit API")).toContain(
			"Audit API finished",
		);
		expect(taskEventMessage(event("completed"), "Audit API")).toContain(
			"Inspect its evidence and diff",
		);
	});

	it("surfaces a blocked child's actual question", () => {
		expect(taskEventMessage(event("blocked"), "Migrate schema")).toContain(
			"is blocked and needs your decision",
		);
	});
});
