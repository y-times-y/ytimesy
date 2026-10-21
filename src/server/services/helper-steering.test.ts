import { describe, expect, it, vi } from "vitest";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import { steeringTimelineItem } from "../adapters/server-peer-inbox";
import {
	type HelperSteeringDeps,
	sendUserMessageToHelper,
} from "./helper-steering";

vi.mock("../adapters/database", () => ({ database: () => ({}) }));
vi.mock("../jobs/queue", () => ({ enqueuePeerMessage: vi.fn() }));

const PROJECT = "11111111-1111-4111-8111-111111111111";

function row(
	id: string,
	parentSessionId: string | null,
	extra: Partial<AgentSessionRecord> = {},
) {
	return {
		id,
		parentSessionId,
		userId: "owner",
		projectId: PROJECT,
		title: id,
		harness: "api",
		listedModelId: "model",
		turnStatus: "running",
		createdAt: "2026-10-21T10:00:00Z",
		updatedAt: "2026-10-21T10:00:00Z",
		items: [],
		agentRole: parentSessionId ? "writer" : null,
		taskState: "working",
		...extra,
	} as AgentSessionRecord;
}

function deps(sessions: AgentSessionRecord[]) {
	const byId = new Map(sessions.map((session) => [session.id, session]));
	return {
		session: vi.fn(async (userId: string, id: string) => {
			const found = byId.get(id);
			return found?.userId === userId ? found : null;
		}),
		descendants: vi.fn(async (userId: string, rootId: string) => {
			const out: AgentSessionRecord[] = [];
			const walk = (parent: string) => {
				for (const session of sessions)
					if (session.parentSessionId === parent && session.userId === userId) {
						out.push(session);
						walk(session.id);
					}
			};
			walk(rootId);
			return out;
		}),
		enqueue: vi.fn<HelperSteeringDeps["enqueue"]>(async () => "job"),
		notifyLead: vi.fn(async () => {}),
		now: () => Date.parse("2026-10-21T10:05:00Z"),
	} satisfies HelperSteeringDeps;
}

const input = {
	userId: "owner",
	projectId: PROJECT,
	rootSessionId: "root",
	helperId: "helper",
	message: "  Skip the docs  ",
	requestId: "req-1",
};

describe("the user steering a helper", () => {
	it("queues it as agent_send steering from the helper's parent and tells the lead", async () => {
		const fake = deps([
			row("root", null),
			row("helper", "root", {
				agentBudget: {
					steps: 1,
					minutes: 1,
					tokens: 1,
					sidekick: { maxRounds: 6 },
				} as never,
			}),
		]);
		await expect(sendUserMessageToHelper(input, fake)).resolves.toMatchObject({
			name: "Sidekick A",
			status: "queued",
		});
		expect(fake.enqueue).toHaveBeenCalledWith(
			{
				userId: "owner",
				senderId: "root",
				recipientId: "helper",
				message: "Skip the docs",
				fromUser: true,
			},
			"user:helper:req-1",
		);
		expect(fake.notifyLead).toHaveBeenCalledWith(
			"root",
			"user-steer:req-1",
			"The user sent Sidekick A: Skip the docs",
		);
	});
	it("reaches a nested helper through its own parent", async () => {
		const fake = deps([
			row("root", null),
			row("writer", "root"),
			row("helper", "writer", { agentRole: "researcher" }),
		]);
		await sendUserMessageToHelper(input, fake);
		expect(fake.enqueue.mock.calls[0]?.[0]).toMatchObject({
			senderId: "writer",
			recipientId: "helper",
		});
	});
	it("refuses a chat the user does not own", async () => {
		const fake = deps([
			row("root", null, { userId: "someone-else" }),
			row("helper", "root", { userId: "someone-else" }),
		]);
		await expect(sendUserMessageToHelper(input, fake)).rejects.toThrow(
			"That chat is not available.",
		);
		expect(fake.enqueue).not.toHaveBeenCalled();
	});
	it("refuses an agent outside this chat", async () => {
		const fake = deps([
			row("root", null),
			row("other-root", null),
			row("helper", "other-root"),
		]);
		await expect(sendUserMessageToHelper(input, fake)).rejects.toThrow(
			"not part of this chat",
		);
		expect(fake.enqueue).not.toHaveBeenCalled();
	});
	it("refuses a subchat that is the root itself or a project mismatch", async () => {
		const fake = deps([row("root", null), row("helper", "root")]);
		await expect(
			sendUserMessageToHelper({ ...input, helperId: "root" }, fake),
		).rejects.toThrow("not part of this chat");
		await expect(
			sendUserMessageToHelper(
				{ ...input, projectId: "22222222-2222-4222-8222-222222222222" },
				fake,
			),
		).rejects.toThrow("That chat is not available.");
	});
	it("refuses a helper that has finished", async () => {
		const fake = deps([
			row("root", null),
			row("helper", "root", { turnStatus: "completed", taskState: "done" }),
		]);
		await expect(sendUserMessageToHelper(input, fake)).rejects.toThrow(
			"no longer running",
		);
		expect(fake.enqueue).not.toHaveBeenCalled();
		expect(fake.notifyLead).not.toHaveBeenCalled();
	});
	it("refuses an empty message", async () => {
		const fake = deps([row("root", null), row("helper", "root")]);
		await expect(
			sendUserMessageToHelper({ ...input, message: "   " }, fake),
		).rejects.toThrow("Write a message first.");
	});
});

describe("delivered steering in the helper's transcript", () => {
	it("becomes a timeline message; other runtime notices do not", () => {
		expect(
			steeringTimelineItem(
				"job",
				"Message from the user, sent directly from the chat:\n\nSkip the docs\n\nCoordination message ID: job",
			),
		).toMatchObject({ kind: "userMessage", id: "steer:job" });
		expect(
			steeringTimelineItem("n", "The user sent Sidekick A: hi"),
		).toBeNull();
	});
});
