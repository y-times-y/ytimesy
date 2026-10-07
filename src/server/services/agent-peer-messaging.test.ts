import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import {
	deliverAgentPeerMessage,
	discoverAgentPeers,
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
	reserved: vi.fn(async () => false),
}));
vi.mock("../adapters/agent-task-command-receipts", () => ({
	isServerControlledIntegration: fake.reserved,
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
	descendantAgentSessions: async (owner: string, id: string) => {
		const included = new Set([id]);
		for (let pass = 0; pass < fake.sessions.size; pass++)
			for (const row of fake.sessions.values())
				if (
					row.userId === owner &&
					row.parentSessionId &&
					included.has(row.parentSessionId)
				)
					included.add(row.id);
		return [...fake.sessions.values()].filter(
			(row) => row.id !== id && included.has(row.id),
		);
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
		candidateIndex: null,
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
	senderId: "a",
	recipientId: "b",
	message: "I will drop the duplicate investigation. Please own src/schema.ts.",
};

beforeEach(() => {
	vi.clearAllMocks();
	fake.sessions.clear();
	fake.accepted.mockResolvedValue(false);
	fake.reserved.mockResolvedValue(false);
	session("root", null);
	session("a", "root");
	session("b", "root");
	fake.enqueue.mockResolvedValue("job");
	fake.send.mockImplementation(() =>
		Effect.succeed({
			connection: { status: "authenticated" },
			turnStatus: "running",
		}),
	);
});

describe("peer coordination boundaries", () => {
	it("rejects messages to a server integration draft before enqueue and drops previously queued messages before delivery", async () => {
		fake.reserved.mockResolvedValue(true);
		await expect(
			queueAgentPeerMessage(requiredSession("a"), "b", "Guidance", "call"),
		).rejects.toThrow("server-controlled");
		expect(fake.enqueue).not.toHaveBeenCalled();
		await deliverAgentPeerMessage(machines, message, "message");
		expect(fake.stage).not.toHaveBeenCalled();
		expect(fake.send).not.toHaveBeenCalled();
	});
	it("discovers siblings, parent, and nested peers but not unrelated roots", async () => {
		session("nested", "b");
		session("other", null);
		session("foreign", "root", { userId: "someone-else" });
		expect(
			(await discoverAgentPeers(requiredSession("a"))).map((row) => row.id),
		).toEqual(["root", "b", "nested"]);
	});
	it("isolates competing implementations and their children", async () => {
		session("a", "root", { candidateIndex: 1 });
		session("b", "root", { candidateIndex: 2 });
		session("a-build", "a");
		session("b-build", "b");
		expect(
			(await discoverAgentPeers(requiredSession("a-build"))).map(
				(row) => row.id,
			),
		).toEqual(["a"]);
		expect(await discoverAgentPeers(requiredSession("root"))).toEqual([]);
	});
	it("rejects self, other tree, other owner, and drafts", async () => {
		session("other", null);
		session("foreign", "root", { userId: "foreign" });
		session("draft", "root", { taskState: "draft" });
		for (const id of ["a", "other", "foreign", "draft"])
			await expect(
				queueAgentPeerMessage(requiredSession("a"), id, "hello", "request"),
			).rejects.toThrow("not available");
		expect(fake.enqueue).not.toHaveBeenCalled();
	});
	it("rejects broken ownership ancestry", async () => {
		session("root", null, { userId: "other" });
		await expect(discoverAgentPeers(requiredSession("a"))).rejects.toThrow(
			"hierarchy",
		);
	});
	it("rejects empty and oversized content", async () => {
		for (const text of [" ", "x".repeat(8001)])
			await expect(
				queueAgentPeerMessage(requiredSession("a"), "b", text, "request"),
			).rejects.toThrow("characters");
	});
	it("durably queues with server-owned sender identity and stable request deduplication key", async () => {
		expect(
			await queueAgentPeerMessage(
				requiredSession("a"),
				"b",
				message.message,
				"request",
			),
		).toMatchObject({ status: "queued", delivery: "next_safe_point" });
		expect(fake.enqueue).toHaveBeenCalledWith(message, "a:request");
	});
	it("accepts the durable queue's duplicate-request acknowledgement", async () => {
		fake.enqueue.mockResolvedValue(null);
		expect(
			await queueAgentPeerMessage(
				requiredSession("a"),
				"b",
				"hello",
				"same-request",
			),
		).toMatchObject({ status: "queued" });
	});
	it("does not acknowledge a queue outage as successful delivery", async () => {
		fake.enqueue.mockRejectedValue(new Error("queue unavailable"));
		await expect(
			queueAgentPeerMessage(requiredSession("a"), "b", "hello", "request"),
		).rejects.toThrow("queue unavailable");
	});
});

describe("queued peer delivery", () => {
	it("stages a busy agent's message without restarting its turn", async () => {
		session("b", "root", { turnStatus: "running" });
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
		session("b", "root", { turnStatus: "completed" });
		await deliverAgentPeerMessage(machines, message, "job");
		expect(fake.send).toHaveBeenCalledOnce();
	});
	it("finishes the queue job once an active runtime acknowledges the message", async () => {
		session("b", "root", { turnStatus: "running" });
		fake.accepted.mockResolvedValueOnce(true);
		await deliverAgentPeerMessage(machines, message, "job");
		expect(fake.send).not.toHaveBeenCalled();
		expect(machines.exec).not.toHaveBeenCalled();
	});
	for (const harness of ["codex", "claude", "api"] as const)
		it(`wakes an idle ${harness} peer through its own adapter`, async () => {
			session("b", "root", { harness });
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
						"do not create acknowledgement loops",
					),
				}),
			);
		});
	it("does not replay a message already admitted before a worker restart", async () => {
		await deliverAgentPeerMessage(machines, message, "job");
		const text = fake.send.mock.calls[0][2].text;
		session("b", "root", {
			items: [{ kind: "userMessage", id: "item", text }],
		});
		await deliverAgentPeerMessage(machines, message, "job");
		expect(fake.send).toHaveBeenCalledTimes(1);
	});
	it("recognizes the native runtime's full prompt when retrying delivery", async () => {
		await deliverAgentPeerMessage(machines, message, "job");
		const text = fake.send.mock.calls[0][2].runtimeText;
		session("b", "root", {
			items: [{ kind: "userMessage", id: "native-item", text }],
		});
		await deliverAgentPeerMessage(machines, message, "job");
		expect(fake.send).toHaveBeenCalledOnce();
	});
	it("revalidates recipients after queueing and drops deleted or reparented targets", async () => {
		session("other", null);
		session("b", "other");
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
