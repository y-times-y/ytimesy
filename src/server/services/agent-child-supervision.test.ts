import { beforeEach, expect, it, vi } from "vitest";
import {
	recoverChildTurnEvents,
	superviseAgentChildren,
} from "./agent-child-supervision";

const mocks = vi.hoisted(() => ({
	query: vi.fn(),
	owner: vi.fn(),
	accepted: vi.fn(),
	notify: vi.fn(),
	save: vi.fn(),
	enqueue: vi.fn(),
}));
vi.mock("../adapters/database", () => ({
	database: () => ({ query: mocks.query }),
}));
vi.mock("../adapters/agent-sessions", () => ({
	agentSessionForOwner: mocks.owner,
}));
vi.mock("../adapters/server-peer-inbox", () => ({
	serverPeerMessageAccepted: mocks.accepted,
}));
vi.mock("../adapters/agent-task-events", () => ({
	saveAgentTaskResultAndEvent: mocks.save,
}));
vi.mock("../jobs/queue", () => ({ enqueueAgentTaskEvent: mocks.enqueue }));
vi.mock("./agent-task-event-delivery", () => ({
	deliverParentTaskNotification: mocks.notify,
}));

const child = {
	id: "child",
	user_id: "owner",
	parent_session_id: "parent",
	title: "Implement fix",
	turn_id: "turn",
	started_at: new Date(0),
	updated_at: new Date(0),
	items: [],
};
beforeEach(() => {
	vi.clearAllMocks();
	mocks.query.mockResolvedValue({ rows: [child] });
	mocks.accepted.mockResolvedValue(false);
	mocks.owner.mockImplementation(async (_owner, id) => ({
		id,
		userId: "owner",
		projectId: "project",
		parentSessionId: id === "child" ? "parent" : null,
		turnStatus: "running",
	}));
	mocks.notify.mockResolvedValue(undefined);
	mocks.save.mockResolvedValue("event");
	mocks.enqueue.mockResolvedValue("job");
});
it("checks a quiet child through the parent and does not fabricate child messages", async () => {
	await superviseAgentChildren({} as never, 120000);
	expect(mocks.notify).toHaveBeenCalledWith(
		{},
		expect.objectContaining({ id: "parent" }),
		"supervision-turn-1",
		expect.stringContaining("This is not evidence of failure"),
	);
});
it("does not repeat an acknowledged check-in across restarts", async () => {
	mocks.accepted.mockResolvedValue(true);
	await superviseAgentChildren({} as never, 120000);
	expect(mocks.notify).not.toHaveBeenCalled();
});
it("rechecks child state before waking the parent", async () => {
	mocks.owner.mockImplementation(async (_owner, id) => ({
		id,
		projectId: "project",
		parentSessionId: id === "child" ? "parent" : null,
		turnStatus: "completed",
	}));
	await superviseAgentChildren({} as never, 120000);
	expect(mocks.notify).not.toHaveBeenCalled();
});
it("supervises native child turns using the persisted prompt timing", async () => {
	mocks.query.mockResolvedValue({
		rows: [
			{
				...child,
				turn_id: null,
				started_at: null,
				items: [
					{
						kind: "userMessage",
						id: "prompt",
						text: "Fix it",
						timing: { startedAt: 0 },
					},
				],
			},
		],
	});
	await superviseAgentChildren({} as never, 120000);
	expect(mocks.notify).toHaveBeenCalledTimes(1);
});
it("recovers a failed child after worker loss without replaying tools", async () => {
	mocks.query.mockResolvedValue({
		rows: [{ id: "turn", session_id: "child", state: "failed", items: [] }],
	});
	await recoverChildTurnEvents();
	expect(mocks.save).toHaveBeenCalledWith(
		expect.objectContaining({
			turnId: "turn",
			eventType: "failed",
			summary: expect.stringContaining("not replayed"),
		}),
	);
	expect(mocks.enqueue).toHaveBeenCalledWith("event");
});
