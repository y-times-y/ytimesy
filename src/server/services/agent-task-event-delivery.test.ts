import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTaskEvent } from "#/server/adapters/agent-task-events";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import {
	deliverAgentTaskEvents,
	deliverParentTaskNotification,
	REPORT_HELD_FOR_TURN,
	subagentReportMessage,
} from "./agent-task-event-delivery";

const mocks = vi.hoisted(() => ({
	accepted: vi.fn(),
	stage: vi.fn(),
	remove: vi.fn(),
	ack: vi.fn(),
	send: vi.fn(),
	claim: vi.fn(),
	defer: vi.fn(),
	delivered: vi.fn(),
	session: vi.fn(),
}));
vi.mock("#/server/adapters/agent-task-events", () => ({
	claimAgentTaskEvent: mocks.claim,
	deferAgentTaskEvent: mocks.defer,
	markAgentTaskEventDelivered: mocks.delivered,
}));
vi.mock("#/server/adapters/agent-sessions", () => ({
	agentSessionForOwner: mocks.session,
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
beforeEach(() => {
	vi.clearAllMocks();
	mocks.accepted.mockResolvedValue(false);
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
	parentSessionId: "main",
} as AgentSessionRecord;

it("holds a report to a chat whose turn runs: no mid-turn injection, no second turn", async () => {
	await expect(
		deliverParentTaskNotification(
			{} as never,
			{ ...parent, parentSessionId: null },
			"event-1",
			"Child finished",
		),
	).rejects.toThrow(REPORT_HELD_FOR_TURN);
	expect(mocks.stage).not.toHaveBeenCalled();
	expect(mocks.send).not.toHaveBeenCalled();
});
it("a held report deferred by its own delivery job is not an error: the turn's end releases it", async () => {
	const event = {
		id: "event-1",
		userId: "owner",
		parentSessionId: "main",
		childSessionId: "child",
		eventType: "completed",
		payload: { message: "Child finished" },
	} as unknown as AgentTaskEvent;
	mocks.claim.mockResolvedValueOnce(event);
	mocks.session.mockImplementation(async (_user: string, id: string) =>
		id === "main"
			? { ...parent, id: "main", parentSessionId: null }
			: { ...parent, id: "child", agentRole: "writer" },
	);
	await expect(deliverAgentTaskEvents({} as never, "event-1")).resolves.toBe(0);
	expect(mocks.defer).toHaveBeenCalledWith("event-1", REPORT_HELD_FOR_TURN);
	expect(mocks.delivered).not.toHaveBeenCalled();
	expect(mocks.send).not.toHaveBeenCalled();
});
it("injects notifications into an active subagent parent without launching a second turn", async () => {
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
		"full report is in the subagent's card",
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

describe("subagent report messages", () => {
	it("passes the report through as a claim for the parent to verify", () => {
		const message = subagentReportMessage(event("completed"));
		expect(message).toContain("Evidence here");
		expect(message).toContain("Treat it as a claim");
		expect(message).toContain("give a full report");
		expect(subagentReportMessage(event("blocked"))).toContain("Evidence here");
	});
});
