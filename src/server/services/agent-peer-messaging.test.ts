import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { newSidekickState } from "#/domain/sidekick";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import {
	deliverAgentPeerMessage,
	queueAgentPeerMessage,
} from "./agent-peer-messaging";
import type { WorkspaceMachines } from "./workspace-machines";

const fake = vi.hoisted(() => ({
	sessions: new Map<string, AgentSessionRecord>(),
	enqueue: vi.fn(),
	send: vi.fn(),
	stage: vi.fn(),
	accepted: vi.fn(async () => false),
	removePending: vi.fn(),
	activeTurn: vi.fn(async () => false),
}));
vi.mock("../adapters/api-turns", () => ({
	hasActiveApiTurn: fake.activeTurn,
}));
vi.mock("../adapters/server-peer-inbox", () => ({
	stageServerPeerMessage: fake.stage,
	serverPeerMessageAccepted: fake.accepted,
	removePendingServerPeerMessage: fake.removePending,
}));
vi.mock("../adapters/agent-sessions", () => ({
	agentSessionForOwner: async (owner: string, id: string) => {
		const row = fake.sessions.get(id);
		return row?.userId === owner ? row : null;
	},
}));
vi.mock("../jobs/queue", () => ({ enqueuePeerMessage: fake.enqueue }));
vi.mock("./harness-workspace-session", () => ({
	sendHarnessWorkspaceTask: fake.send,
}));
vi.mock("./session-workspace-machines", () => ({
	machinesForAgentSession: (machines: unknown) => machines,
}));

function session(
	id: string,
	parentSessionId: string | null,
	extra: Partial<AgentSessionRecord> = {},
) {
	const row = {
		id,
		parentSessionId,
		userId: "owner",
		projectId: "project",
		title: id,
		taskState: "working",
		providerRef: "executor",
		listedModelId: "model",
		harness: "codex",
		turnStatus: "idle",
		items: [],
		...extra,
	} as AgentSessionRecord;
	fake.sessions.set(id, row);
	return row;
}
const machines = {
	readTextFile: vi.fn(async () => null),
	exec: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
} as unknown as WorkspaceMachines;
function requiredSession(id: string) {
	const row = fake.sessions.get(id);
	if (!row) throw new Error(`Missing fixture: ${id}`);
	return row;
}
const message = {
	userId: "owner",
	senderId: "root",
	recipientId: "b",
	message: "I will drop the duplicate investigation. Please own src/schema.ts.",
};

beforeEach(() => {
	vi.clearAllMocks();
	fake.sessions.clear();
	fake.accepted.mockResolvedValue(false);
	fake.activeTurn.mockResolvedValue(false);
	session("root", null);
	session("a", "root", { agentRole: "researcher" });
	session("b", "root", { agentRole: "writer" });
	fake.enqueue.mockResolvedValue("job");
	fake.send.mockImplementation(() =>
		Effect.succeed({
			connection: { status: "authenticated" },
			turnStatus: "running",
		}),
	);
});

describe("agent_send boundaries", () => {
	it("steers only the sender's own started subagents", async () => {
		session("nested", "b", { agentRole: "researcher" });
		session("legacy", "root");
		session("other", null);
		session("foreign", "root", { userId: "foreign", agentRole: "writer" });
		session("draft", "root", { taskState: "draft", agentRole: "writer" });
		for (const id of ["root", "nested", "legacy", "other", "foreign", "draft"])
			await expect(
				queueAgentPeerMessage(requiredSession("root"), id, "hello", "request"),
			).rejects.toThrow("not available");
		// A sibling is not a parent.
		await expect(
			queueAgentPeerMessage(requiredSession("a"), "b", "hello", "request"),
		).rejects.toThrow("not available");
		expect(fake.enqueue).not.toHaveBeenCalled();
	});
	it("rejects empty and oversized content", async () => {
		for (const text of [" ", "x".repeat(8001)])
			await expect(
				queueAgentPeerMessage(requiredSession("root"), "b", text, "request"),
			).rejects.toThrow("characters");
	});
	it("durably queues with server-owned sender identity and stable request deduplication key", async () => {
		expect(
			await queueAgentPeerMessage(
				requiredSession("root"),
				"b",
				message.message,
				"request",
			),
		).toMatchObject({ status: "queued", delivery: "next_safe_point" });
		expect(fake.enqueue).toHaveBeenCalledWith(message, "root:request");
	});
	it("accepts the durable queue's duplicate-request acknowledgement", async () => {
		fake.enqueue.mockResolvedValue(null);
		expect(
			await queueAgentPeerMessage(
				requiredSession("root"),
				"b",
				"hello",
				"same-request",
			),
		).toMatchObject({ status: "queued" });
	});
	it("does not acknowledge a queue outage as successful delivery", async () => {
		fake.enqueue.mockRejectedValue(new Error("queue unavailable"));
		await expect(
			queueAgentPeerMessage(requiredSession("root"), "b", "hello", "request"),
		).rejects.toThrow("queue unavailable");
	});
});

describe("queued steering delivery", () => {
	it("drops a round message to a retired sidekick instead of waking it beside its lead", async () => {
		session("b", "root", {
			turnStatus: "completed",
			agentRole: "writer",
			agentBudget: {
				steps: 1,
				minutes: 1,
				tokens: 1,
				sidekick: {
					...newSidekickState({ tokens: 1 }, "2026-10-20T12:00:00.000Z"),
					retired: {
						at: "2026-10-20T12:06:00.000Z",
						reason: "round 1 did not run or report",
					},
				},
			},
		});
		await deliverAgentPeerMessage(machines, message, "job");
		expect(fake.stage).not.toHaveBeenCalled();
		expect(fake.send).not.toHaveBeenCalled();
	});
	it("stages a waiting child's reply while its durable API turn remains active", async () => {
		session("b", "root", {
			agentRole: "writer",
			turnStatus: "idle",
			taskState: "waiting",
		});
		fake.activeTurn.mockResolvedValue(true);
		await expect(
			deliverAgentPeerMessage(machines, message, "job"),
		).rejects.toThrow("safe point");
		expect(fake.stage).toHaveBeenCalledWith(
			"b",
			"job",
			expect.stringContaining(message.message),
		);
		expect(fake.send).not.toHaveBeenCalled();
	});
	it("stages a busy subagent's steering without restarting its turn", async () => {
		session("b", "root", { agentRole: "writer", turnStatus: "running" });
		await expect(
			deliverAgentPeerMessage(machines, message, "job"),
		).rejects.toThrow("safe point");
		expect(fake.stage).toHaveBeenCalledWith(
			"b",
			"job",
			expect.stringContaining(message.message),
		);
		expect(machines.exec).not.toHaveBeenCalled();
		expect(fake.send).not.toHaveBeenCalled();
		session("b", "root", { agentRole: "writer", turnStatus: "completed" });
		await deliverAgentPeerMessage(machines, message, "job");
		expect(fake.send).toHaveBeenCalledOnce();
	});
	it("delivers the user's own message to a running helper as theirs, not the parent's", async () => {
		session("b", "root", { agentRole: "writer", turnStatus: "running" });
		await expect(
			deliverAgentPeerMessage(
				machines,
				{ ...message, message: "Skip the docs", fromUser: true },
				"job-user",
			),
		).rejects.toThrow("safe point");
		const staged = fake.stage.mock.calls[0]?.[2] as string;
		expect(staged).toContain(
			"Message from the user, sent directly from the chat:\n\nSkip the docs",
		);
		expect(staged).toContain("This is the user steering you directly");
		expect(staged).not.toContain("Message from root");
	});
	it("finishes the queue job once an active runtime acknowledges the message", async () => {
		session("b", "root", { agentRole: "writer", turnStatus: "running" });
		fake.accepted.mockResolvedValueOnce(true);
		await deliverAgentPeerMessage(machines, message, "job");
		expect(fake.send).not.toHaveBeenCalled();
		expect(machines.exec).not.toHaveBeenCalled();
	});
	for (const harness of ["codex", "api"] as const)
		it(`wakes an idle ${harness} subagent through its own adapter`, async () => {
			session("b", "root", { agentRole: "writer", harness });
			await deliverAgentPeerMessage(machines, message, "job");
			expect(fake.send).toHaveBeenCalledWith(
				machines,
				expect.objectContaining({
					harnessId: harness,
					sessionId: "b",
					userId: "owner",
				}),
				expect.objectContaining({
					modelId: "model",
					runtimeText: expect.stringContaining(
						"your parent agent steering your brief",
					),
				}),
			);
		});
	it("does not replay a message already admitted before a worker restart", async () => {
		await deliverAgentPeerMessage(machines, message, "job");
		const text = fake.send.mock.calls[0][2].text;
		session("b", "root", {
			agentRole: "writer",
			items: [{ kind: "userMessage", id: "item", text }],
		});
		await deliverAgentPeerMessage(machines, message, "job");
		expect(fake.send).toHaveBeenCalledTimes(1);
	});
	it("recognizes the full runtime prompt when retrying delivery", async () => {
		await deliverAgentPeerMessage(machines, message, "job");
		const text = fake.send.mock.calls[0][2].runtimeText;
		session("b", "root", {
			agentRole: "writer",
			items: [{ kind: "userMessage", id: "native-item", text }],
		});
		await deliverAgentPeerMessage(machines, message, "job");
		expect(fake.send).toHaveBeenCalledOnce();
	});
	it("revalidates recipients after queueing and drops deleted or reparented targets", async () => {
		session("other", null);
		session("b", "other", { agentRole: "writer" });
		await deliverAgentPeerMessage(machines, message, "job");
		expect(fake.send).not.toHaveBeenCalled();
	});
	it("propagates dispatch failures for queue retry", async () => {
		fake.send.mockReturnValue(
			Effect.succeed({
				connection: { status: "failed" },
				turnStatus: "failed",
			}),
		);
		await expect(
			deliverAgentPeerMessage(machines, message, "job"),
		).rejects.toThrow("dispatch failed");
	});
});
