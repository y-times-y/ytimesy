import { Effect } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deliverPrRepairEvents } from "./pr-repair";
import type { WorkspaceMachines } from "./workspace-machines";

const mocks = vi.hoisted(() => ({
	query: vi.fn(),
	connect: vi.fn(),
	session: vi.fn(),
	evidence: vi.fn(),
	send: vi.fn(),
	release: vi.fn(),
	wakes: vi.fn(),
}));
vi.mock("./pull-request-wake", () => ({
	deliverPullRequestWakes: mocks.wakes,
}));
vi.mock("../adapters/database", () => ({
	database: () => ({ query: mocks.query, connect: mocks.connect }),
}));
vi.mock("../adapters/agent-sessions", () => ({
	agentSessionForOwner: mocks.session,
}));
vi.mock("../adapters/github/pr-repair-evidence", () => ({
	currentPrRepairEvidence: mocks.evidence,
}));
vi.mock("./harness-workspace-session", () => ({
	sendHarnessWorkspaceTask: mocks.send,
}));

const event = {
	delivery_id: "00000000-0000-4000-8000-000000000001",
	session_id: "child",
	user_id: "owner",
	installation_id: "1",
	counted: false,
	signal: {
		repositoryId: 1,
		fullName: "owner/repo",
		installationId: 1,
		headSha: "a".repeat(40),
		kind: "check_run",
		sourceId: 3,
		prNumber: null,
	},
};
let attempts = 0;
let counted = false;
let receiptExists = false;
let claimed = false;
beforeEach(() => {
	vi.stubEnv("YTIMESY_PR_REPAIR_ENABLED", "1");
	attempts = 0;
	counted = false;
	receiptExists = false;
	claimed = false;
	mocks.query.mockImplementation(async (sql: string) => {
		if (sql.startsWith("with next")) {
			if (claimed) return { rows: [] };
			claimed = true;
			return { rows: [event] };
		}
		if (sql.startsWith("select id from api_turn"))
			return { rows: receiptExists ? [{ id: "accepted" }] : [] };
		if (sql.startsWith("select attempts"))
			return { rows: [{ attempts, paused: false }] };
		if (sql.startsWith("select counted")) return { rows: [{ counted }] };
		if (sql.startsWith("update agent_pr_repair_control set attempts"))
			attempts++;
		if (sql.startsWith("update agent_pr_repair_event set counted"))
			counted = true;
		return { rows: [] };
	});
	mocks.connect.mockResolvedValue({
		query: mocks.query,
		release: mocks.release,
	});
	mocks.session.mockResolvedValue({
		id: "child",
		userId: "owner",
		projectId: "project",
		parentSessionId: "lead",
		taskAccess: "read_write",
		harness: "codex",
		taskPullRequestUrl: "https://github.com/owner/repo/pull/1",
		listedModelId: "codex/model",
		turnStatus: "completed",
	});
	mocks.evidence.mockResolvedValue("Current failure evidence");
	mocks.send.mockReturnValue(
		Effect.succeed({
			connection: { status: "connected" },
			turnStatus: "running",
		}),
	);
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.resetAllMocks();
});
const machines = {} as WorkspaceMachines;

it("recovers an accepted wakeup without refetching a head that may have changed", async () => {
	receiptExists = true;
	await deliverPrRepairEvents(machines);
	expect(mocks.evidence).not.toHaveBeenCalled();
	expect(mocks.send).not.toHaveBeenCalled();
	expect(mocks.query).toHaveBeenCalledWith(
		expect.stringContaining("status=$3"),
		[event.delivery_id, "child", "delivered", null],
	);
});
it("waits for a busy child without interrupting it or consuming an attempt", async () => {
	mocks.session.mockResolvedValue({
		...(await mocks.session()),
		turnStatus: "running",
	});
	await deliverPrRepairEvents(machines);
	expect(mocks.send).not.toHaveBeenCalled();
	expect(mocks.evidence).not.toHaveBeenCalled();
	expect(attempts).toBe(0);
});
it("ignores stale PR evidence", async () => {
	mocks.evidence.mockResolvedValue(null);
	await deliverPrRepairEvents(machines);
	expect(mocks.send).not.toHaveBeenCalled();
	expect(attempts).toBe(0);
});
it("blocks the fourth automatic repair", async () => {
	attempts = 3;
	await deliverPrRepairEvents(machines);
	expect(mocks.send).not.toHaveBeenCalled();
	expect(mocks.query).toHaveBeenCalledWith(
		expect.stringContaining("status=$3"),
		expect.arrayContaining(["blocked"]),
	);
});
it("dispatches the same model with a durable idempotency key and counts once", async () => {
	await deliverPrRepairEvents(machines);
	expect(mocks.send).toHaveBeenCalledWith(
		machines,
		expect.objectContaining({ sessionId: "child", harnessId: "codex" }),
		expect.objectContaining({
			modelId: "codex/model",
			idempotencyKey: `pr-repair:${event.delivery_id}:child`,
		}),
	);
	expect(attempts).toBe(1);
	claimed = false;
	await deliverPrRepairEvents(machines);
	expect(attempts).toBe(1);
});
it("delivers chat wake-ups for ytimesy pull requests after task repairs", async () => {
	claimed = true;
	await deliverPrRepairEvents(machines);
	expect(mocks.wakes).toHaveBeenCalledWith(machines);
	vi.stubEnv("YTIMESY_PR_REPAIR_ENABLED", "0");
	mocks.wakes.mockClear();
	await deliverPrRepairEvents(machines);
	expect(mocks.wakes).not.toHaveBeenCalled();
});
