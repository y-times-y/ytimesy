import { expect, it } from "vitest";
import { shouldPollAgentTasks } from "./agent-task";
import { agentTodosFromUnknown } from "./agent-todos";

it("discovers tasks from an empty list while the lead runs and follows waiting children", () => {
	expect(shouldPollAgentTasks("running", [])).toBe(true);
	expect(shouldPollAgentTasks("completed", [{ status: "waiting" }])).toBe(true);
	expect(shouldPollAgentTasks("completed", [{ status: "done" }])).toBe(false);
});

it("normalizes checklist statuses without inferring completion", () => {
	expect(
		agentTodosFromUnknown([
			{ step: "Inspect", status: "pending" },
			{ content: "Test", status: "completed" },
			{ text: "Bad", status: "unknown" },
			null,
		]),
	).toEqual([
		{ text: "Inspect", status: "pending" },
		{ text: "Test", status: "completed" },
	]);
});
