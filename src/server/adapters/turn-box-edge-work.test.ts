import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiTurn } from "./api-turns";

const mocks = vi.hoisted(() => ({
	owner: { id: "s1", userId: "u1", parentSessionId: null, providerRef: "vm-1" },
	order: [] as string[],
	commit: vi.fn(),
	finish: vi.fn(),
	report: vi.fn(),
	release: vi.fn(),
	enqueue: vi.fn(),
	queued: vi.fn(),
}));
vi.mock("./agent-sessions", () => ({
	agentSessionMetadataForOwner: async () => mocks.owner,
}));
vi.mock("./agent-task-events", () => ({
	releaseHeldAgentTaskEvents: mocks.release,
}));
vi.mock("./api-turns", () => ({ replaceSettledTurnItem: vi.fn() }));
vi.mock("./after-response", () => ({ startAfterResponse: () => false }));
vi.mock("../services/project-knowledge", () => ({
	recordCloudProjectReport: mocks.report,
}));
vi.mock("../services/turn-commit", () => ({ commitSessionTurn: mocks.commit }));
vi.mock("../jobs/api-turn", () => ({ finishPullRequestHandoff: mocks.finish }));
vi.mock("../jobs/queue", () => ({ enqueueAgentTaskEvent: mocks.enqueue }));
vi.mock("../services/queued-user-messages", () => ({
	startQueuedUserTurn: mocks.queued,
}));

import { afterBoxTurnSettled } from "./turn-box-edge-work";

const turn = { id: "t1", user_id: "u1", session_id: "s1" } as ApiTurn;
const machines = { exec: vi.fn() } as never;

beforeEach(() => {
	for (const fn of [
		mocks.commit,
		mocks.finish,
		mocks.report,
		mocks.release,
		mocks.enqueue,
		mocks.queued,
	])
		fn.mockReset();
	mocks.release.mockResolvedValue(1);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("afterBoxTurnSettled (the edge's work after a box's turn settled)", () => {
	it("publishes what the edge committed, then reports, delivers held reports and starts the next queued message", async () => {
		const publish = vi.fn();
		mocks.commit.mockResolvedValue({ publish });
		await afterBoxTurnSettled(
			turn,
			{ state: "completed", items: [], publish: true },
			{ machines: () => machines },
		);
		expect(mocks.commit).toHaveBeenCalledOnce();
		expect(mocks.finish).toHaveBeenCalledWith(turn, publish, expect.anything());
		expect(mocks.report).toHaveBeenCalledOnce();
		expect(mocks.enqueue).toHaveBeenCalledOnce();
		expect(mocks.queued).toHaveBeenCalledWith(expect.anything(), "u1", "s1");
	});

	it("a Stop that raced completion still hands off the commit, and does nothing else", async () => {
		const publish = vi.fn();
		mocks.commit.mockResolvedValue({ publish });
		await afterBoxTurnSettled(
			turn,
			{ state: "cancelled", items: [], publish: true },
			{ machines: () => machines },
		);
		expect(mocks.finish).toHaveBeenCalledOnce();
		expect(mocks.report).not.toHaveBeenCalled();
		expect(mocks.queued).not.toHaveBeenCalled();
	});

	it("does not commit or push when the box committed nothing to push", async () => {
		await afterBoxTurnSettled(
			turn,
			{ state: "completed", items: [], publish: false },
			{ machines: () => machines },
		);
		expect(mocks.commit).not.toHaveBeenCalled();
		expect(mocks.queued).toHaveBeenCalledOnce();
	});

	it("one failing step never stops the next (each is best effort, as at the end of runApiTurn)", async () => {
		mocks.commit.mockRejectedValue(new Error("GitHub is down"));
		mocks.report.mockRejectedValue(new Error("db"));
		await afterBoxTurnSettled(
			turn,
			{ state: "completed", items: [], publish: true },
			{ machines: () => machines },
		);
		expect(mocks.queued).toHaveBeenCalledOnce();
	});
});
