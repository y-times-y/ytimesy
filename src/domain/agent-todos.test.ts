import { expect, it } from "vitest";
import { shouldPollSubagents } from "./agent-task";

it("discovers tasks from an empty list while the lead runs and follows waiting children", () => {
	expect(shouldPollSubagents("running", [])).toBe(true);
	expect(shouldPollSubagents("completed", [{ status: "waiting" }])).toBe(true);
	expect(shouldPollSubagents("completed", [{ status: "done" }])).toBe(false);
});
