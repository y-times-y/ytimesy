import { describe, expect, it } from "vitest";
import type { AgentTaskEvent } from "#/server/adapters/agent-task-events";
import { taskEventMessage } from "./agent-task-event-delivery";

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
