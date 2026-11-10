import { describe, expect, it } from "vitest";
import { leavesClaudeCodeRunning } from "./claude-code-turn";

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
