import { describe, expect, it } from "vitest";
import {
	intervalUnionMs,
	isWorkspaceVmTool,
	turnToolTime,
} from "./turn-tool-time";

describe("intervalUnionMs", () => {
	it("is zero for no intervals and ignores empty or inverted ones", () => {
		expect(intervalUnionMs([])).toBe(0);
		expect(
			intervalUnionMs([
				[5, 5],
				[9, 3],
			]),
		).toBe(0);
	});

	it("adds disjoint intervals", () => {
		expect(
			intervalUnionMs([
				[20, 30],
				[0, 10],
			]),
		).toBe(20);
	});

	it("counts overlapping, nested and touching intervals once", () => {
		expect(
			intervalUnionMs([
				[0, 10],
				[5, 15],
				[6, 8],
				[15, 20],
				[30, 40],
				[32, 35],
			]),
		).toBe(30);
	});
});

describe("isWorkspaceVmTool", () => {
	it("splits workspace tools from the others", () => {
		for (const tool of [
			"bash",
			"execute_command",
			"Bash",
			"Read",
			"Edit",
			"read_file",
			"apply_patch",
			"browser_open",
			"run_code",
		])
			expect(isWorkspaceVmTool(tool), tool).toBe(true);
		for (const tool of [
			"update_plan",
			"web_fetch",
			"read_context_archive",
			"ask_user",
			"agent",
		])
			expect(isWorkspaceVmTool(tool), tool).toBe(false);
	});
});

describe("turnToolTime", () => {
	it("logs one line with the union of tool and VM tool time", () => {
		let clock = 1_000;
		const time = turnToolTime({
			turnId: "turn-1",
			step: 2,
			startedAt: 1_000,
			now: () => clock,
		});
		time.setKind("api");
		clock = 1_100;
		time.start("a", "bash");
		clock = 1_150;
		time.start("b", "update_plan");
		clock = 1_200;
		time.end("b");
		clock = 1_300;
		time.end("a");
		time.end("a");
		clock = 1_500;
		time.start("c", "read_file");
		clock = 1_600;
		const lines: string[] = [];
		time.write("continue", (line) => lines.push(line));
		time.write("continue", (line) => lines.push(line));
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] as string)).toEqual({
			event: "turn.tool_time",
			turnId: "turn-1",
			step: 2,
			kind: "api",
			outcome: "continue",
			stepMs: 600,
			toolMs: 300,
			vmToolMs: 300,
			toolCalls: 3,
			unfinished: 1,
		});
	});

	it("never throws when logging fails", () => {
		const time = turnToolTime({ turnId: "t", step: 0, startedAt: 0 });
		expect(() =>
			time.write("error", () => {
				throw new Error("log failed");
			}),
		).not.toThrow();
	});
});
