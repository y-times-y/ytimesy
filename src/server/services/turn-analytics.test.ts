import { beforeEach, expect, it, vi } from "vitest";
import { SessionItemId } from "#/domain/ids";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import { captureTurnTransition } from "./turn-analytics";

const capture = vi.hoisted(() => vi.fn());
vi.mock("../adapters/analytics", () => ({ captureServerAnalytics: capture }));
beforeEach(() => vi.clearAllMocks());
const session = {
	id: "session",
	userId: "user",
	harness: "codex",
	parentSessionId: null,
	taskAccess: "read_only",
	turnStatus: "running",
} as AgentSessionRecord;
const items = [
	{
		kind: "userMessage",
		id: SessionItemId("message"),
		text: "PRIVATE",
		timing: { startedAt: 100, completedAt: 500 },
	},
];

it("counts settled outcomes once per observed transition with measured duration", () => {
	captureTurnTransition(session, "completed", items);
	expect(capture).toHaveBeenCalledWith(
		"user",
		"turn_finished",
		{ runtime: "codex", role: "lead", outcome: "completed", duration_ms: 400 },
		{ key: "session:100:completed", timestamp: new Date(500) },
	);
	capture.mockClear();
	captureTurnTransition(
		{ ...session, turnStatus: "completed" },
		"completed",
		items,
	);
	expect(capture).not.toHaveBeenCalled();
});
it("separates builders and cancellations and ignores untimed legacy history", () => {
	captureTurnTransition(
		{ ...session, parentSessionId: "parent", taskAccess: "read_write" },
		"idle",
		items,
	);
	expect(capture.mock.calls[0][2]).toMatchObject({
		role: "builder",
		outcome: "cancelled",
	});
	capture.mockClear();
	captureTurnTransition(session, "failed", []);
	expect(capture).not.toHaveBeenCalled();
});
it("records dispatch rather than inferring a start from browser clicks", () => {
	captureTurnTransition({ ...session, turnStatus: "idle" }, "running", items);
	expect(capture.mock.calls[0][1]).toBe("turn_started");
	expect(JSON.stringify(capture.mock.calls)).not.toContain("PRIVATE");
});
