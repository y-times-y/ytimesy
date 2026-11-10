import type { ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import {
	claudeCodeBridgeToolSet,
	leavesClaudeCodeRunning,
} from "./claude-code-turn";

describe("leavesClaudeCodeRunning", () => {
	it("lets Claude Code keep running when a deploy reset the Durable Object", () => {
		const reset = new Error(
			"Durable Object reset because its code was updated.",
		);
		expect(leavesClaudeCodeRunning([reset, undefined])).toBe(true);
		// Either the abort's own reason or the step's can carry it.
		expect(
			leavesClaudeCodeRunning([
				new Error("Durable step was interrupted."),
				reset,
			]),
		).toBe(true);
	});

	it("still stops it for a user's Stop, a deadline or any other abort", () => {
		expect(
			leavesClaudeCodeRunning([new Error("Stopped by the user."), undefined]),
		).toBe(false);
		expect(
			leavesClaudeCodeRunning([
				new Error("Durable step was interrupted."),
				undefined,
			]),
		).toBe(false);
		expect(leavesClaudeCodeRunning([undefined, undefined])).toBe(false);
	});
});

describe("claudeCodeBridgeToolSet", () => {
	const tools = {
		read: {},
		bash: {},
		web_fetch: {},
		agent: {},
		run_code: {},
		update_plan: {},
	} as unknown as ToolSet;

	it("on the chat's machine skips what Claude has its own of, code mode and our plan tool", () => {
		expect(
			Object.keys(
				claudeCodeBridgeToolSet(tools, ["read", "bash", "web_fetch"]),
			),
		).toEqual(["agent"]);
	});

	it("on a runner box offers the file and shell tools and run_code, never our plan tool", () => {
		expect(
			Object.keys(claudeCodeBridgeToolSet(tools, ["web_fetch"], true)).sort(),
		).toEqual(["agent", "bash", "read", "run_code"]);
	});
});
