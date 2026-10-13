import { describe, expect, it } from "vitest";
import {
	taskBriefTooLong,
	taskToolAccess,
	taskToolExecution,
	taskToolHarness,
	taskToolPlacement,
	taskToolString,
} from "./agent-task-tool";

describe("agent task tool protocol", () => {
	it("normalizes strings and harnesses", () => {
		expect(taskToolString({ title: "  Audit  " }, "title")).toBe("Audit");
		expect(taskToolHarness({ harness: "api" }, "codex")).toBe("api");
		expect(taskToolHarness({ harness: "claude" }, "codex")).toBe("codex");
		expect(taskToolHarness({}, "api")).toBe("api");
		expect(taskToolPlacement({ placement: "shared" })).toBe("shared");
		expect(taskToolAccess({ access: "read_only" })).toBe("read_only");
		expect(taskToolExecution({ execution: "stacked" })).toBe("stacked");
	});
});

it("bounds task briefs so leads cannot restate the repository", () => {
	expect(taskBriefTooLong("x".repeat(2500))).toBeNull();
	expect(taskBriefTooLong("x".repeat(2501))).toContain("2501 characters");
});
