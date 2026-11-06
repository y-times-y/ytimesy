import { beforeEach, expect, it, vi } from "vitest";
import { recoverChildTurnEvents } from "./subagent-turn-recovery";

const mocks = vi.hoisted(() => ({
	query: vi.fn(),
	owner: vi.fn(),
	report: vi.fn(),
	save: vi.fn(),
	enqueue: vi.fn(),
}));
vi.mock("../adapters/database", () => ({
	database: () => ({ query: mocks.query }),
}));
vi.mock("../adapters/agent-sessions", () => ({
	agentSessionForOwner: mocks.owner,
	agentSessionMetadataForOwner: mocks.owner,
}));
vi.mock("../adapters/agent-task-events", () => ({
	saveAgentTaskResultAndEvent: mocks.save,
}));
vi.mock("../jobs/queue", () => ({ enqueueAgentTaskEvent: mocks.enqueue }));
vi.mock("./subagent-runtime", () => ({ subagentReport: mocks.report }));

beforeEach(() => {
	vi.clearAllMocks();
	mocks.owner.mockImplementation(async (_owner, id) => ({
		id,
		userId: "owner",
		parentSessionId: "parent",
		agentRole: "writer",
	}));
	mocks.report.mockImplementation(
		async ({ outcome, text }) => `[report ${outcome}]\n${text}`,
	);
	mocks.save.mockResolvedValue("event");
	mocks.enqueue.mockResolvedValue("job");
});

it("reports a failed subagent after worker loss without replaying tools", async () => {
	mocks.query.mockResolvedValue({
		rows: [
			{
				id: "turn",
				session_id: "child",
				user_id: "owner",
				state: "failed",
				items: [],
			},
		],
	});
	await recoverChildTurnEvents({} as never);
	expect(mocks.query.mock.calls[0][0]).toContain("c.agent_role is not null");
	expect(mocks.report).toHaveBeenCalledWith(
		expect.objectContaining({
			outcome: "failed",
			session: expect.objectContaining({ id: "child" }),
		}),
	);
	expect(mocks.save).toHaveBeenCalledWith(
		expect.objectContaining({
			turnId: "turn",
			eventType: "failed",
			summary: expect.stringMatching(/report failed[\s\S]*not replayed/),
		}),
	);
	expect(mocks.enqueue).toHaveBeenCalledWith("event");
});

it("falls back to the final text when the report cannot be built", async () => {
	mocks.query.mockResolvedValue({
		rows: [
			{
				id: "turn",
				session_id: "child",
				user_id: "owner",
				state: "completed",
				items: [
					{ kind: "userMessage", id: "u", text: "brief" },
					{ kind: "agentMessage", id: "a", text: "Done: fixed it." },
				],
			},
		],
	});
	mocks.report.mockRejectedValue(new Error("fork gone"));
	await recoverChildTurnEvents({} as never);
	expect(mocks.save).toHaveBeenCalledWith(
		expect.objectContaining({
			eventType: "completed",
			summary: "Done: fixed it.",
		}),
	);
});

it("leaves a just-finished child to its own runtime's report", async () => {
	// A writer's report (with its patch) is saved after the turn row is final;
	// recovering inside that window raced it and dropped the patch block.
	mocks.query.mockResolvedValue({ rows: [] });
	await recoverChildTurnEvents({} as never);
	const [sql, values] = mocks.query.mock.calls.at(-1) as [string, unknown[]];
	expect(sql).toContain("t.updated_at < now() - make_interval(secs => $1)");
	expect(values).toEqual([120]);
});
