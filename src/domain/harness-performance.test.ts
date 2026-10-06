import { expect, it } from "vitest";
import {
	harnessToolMetric,
	reportedToolFailure,
	toolFailureClass,
	toolMetricCategory,
} from "./harness-performance";

it("counts explicit failed outcomes, not just thrown SDK errors", () => {
	for (const value of [
		{ ok: false },
		{ status: "failed" },
		{ exitCode: 2 },
		{ status: 124 },
		{ passed: false },
	])
		expect(reportedToolFailure(value)).toBe(true);
	for (const value of [
		{ ok: true },
		{ status: "running" },
		{ exitCode: 0 },
		"secret",
		null,
	])
		expect(reportedToolFailure(value)).toBe(false);
	expect(toolMetricCategory("wait_command")).toBe("command");
	expect(toolMetricCategory("run_checks")).toBe("command");
	expect(toolMetricCategory("apply_patches")).toBe("edit");
	expect(reportedToolFailure([{ exitCode: 0 }, { exitCode: 1 }])).toBe(true);
	expect(reportedToolFailure({ completed: [], failedPath: "stale.ts" })).toBe(
		true,
	);
	expect(reportedToolFailure([{ exitCode: 0, passed: true }])).toBe(false);
	expect(
		toolFailureClass([{ exitCode: 0 }, { stopped: "timeout", passed: false }]),
	).toBe("timeout");
});

it("rejects arbitrary model-controlled tool names and drops private metric payloads", () => {
	const metric = {
		tool_name: "read_file",
		category: "read",
		duration_ms: 10,
		outcome: "completed",
		error_class: "none",
		repeated_read: false,
	};
	expect(
		harnessToolMetric.parse({ ...metric, input: "SECRET", output: "PRIVATE" }),
	).toEqual(metric);
	expect(
		harnessToolMetric.safeParse({ ...metric, tool_name: "PRIVATE_CUSTOM_TOOL" })
			.success,
	).toBe(false);
});
