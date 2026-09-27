import { describe, expect, it } from "vitest";
import {
	parseAgentTaskToolRequest,
	serializeAgentTaskToolResponse,
	taskToolAccess,
	taskToolExecution,
	taskToolHarness,
	taskToolPlacement,
	taskToolString,
} from "./agent-task-tool";

describe("agent task tool protocol", () => {
	it("accepts only known tools with object arguments", () => {
		expect(
			parseAgentTaskToolRequest(
				JSON.stringify({
					id: "call-edit",
					tool: "edit_task",
					arguments: { taskId: "task-1", title: "Revised" },
				}),
			),
		).toMatchObject({ id: "call-edit", tool: "edit_task" });
		expect(
			parseAgentTaskToolRequest(
				JSON.stringify({ id: "call-1", tool: "start_task", arguments: {} }),
			),
		).toEqual({ id: "call-1", tool: "start_task", arguments: {} });
		expect(
			parseAgentTaskToolRequest(
				JSON.stringify({
					id: "call-2",
					tool: "inspect_task_diff",
					arguments: { taskId: "task-1" },
				}),
			),
		).toEqual({
			id: "call-2",
			tool: "inspect_task_diff",
			arguments: { taskId: "task-1" },
		});
		expect(
			parseAgentTaskToolRequest(
				JSON.stringify({
					id: "call-blocked",
					tool: "report_task_blocked",
					arguments: { question: "Which API should I use?" },
				}),
			),
		).toEqual({
			id: "call-blocked",
			tool: "report_task_blocked",
			arguments: { question: "Which API should I use?" },
		});
		expect(
			parseAgentTaskToolRequest(
				JSON.stringify({ id: "call-3", tool: "delete_project", arguments: {} }),
			),
		).toBeNull();
	});

	it("normalizes strings, harnesses, and newline-delimited responses", () => {
		expect(taskToolString({ title: "  Audit  " }, "title")).toBe("Audit");
		expect(taskToolHarness({ harness: "claude" }, "codex")).toBe("claude");
		expect(taskToolHarness({ harness: "unknown" }, "codex")).toBe("codex");
		expect(taskToolHarness({}, "opencode")).toBe("codex");
		expect(taskToolPlacement({ placement: "shared" })).toBe("shared");
		expect(taskToolAccess({ access: "read_only" })).toBe("read_only");
		expect(taskToolExecution({ execution: "stacked" })).toBe("stacked");
		expect(
			serializeAgentTaskToolResponse({ id: "call-1", ok: true, result: [] }),
		).toBe('{"id":"call-1","ok":true,"result":[]}\n');
	});
});
