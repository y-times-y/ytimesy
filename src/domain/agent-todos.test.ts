import { expect, it } from "vitest";
import { shouldPollAgentTasks } from "./agent-task";

it("discovers tasks from an empty list while the lead runs and follows waiting children", () => {
	expect(shouldPollAgentTasks("running", [])).toBe(true);
	expect(shouldPollAgentTasks("completed", [{ status: "waiting" }])).toBe(true);
	expect(shouldPollAgentTasks("completed", [{ status: "done" }])).toBe(false);
});
