import { describe, expect, it } from "vitest";
import { AGENT_SEND_TOOL, AGENT_TOOL } from "./subagent";
import { ASK_USER_TOOL } from "./user-question";
import {
	appliedBuilderPatchBlock,
	Y_REPLY_WORDS,
	Y_TOOLS,
	yInstructions,
} from "./y-agent";

describe("Y_TOOLS", () => {
	it("keeps delegation, the user's questions and secret requests", () => {
		for (const name of [
			AGENT_TOOL,
			AGENT_SEND_TOOL,
			ASK_USER_TOOL,
			"request_project_secret",
		])
			expect(Y_TOOLS.has(name)).toBe(true);
	});

	it("keeps no tool that reads, changes or runs code", () => {
		for (const name of [
			"bash",
			"read",
			"write",
			"edit",
			"run_code",
			"exec_command",
			"apply_patch",
			"web_fetch",
		])
			expect(Y_TOOLS.has(name)).toBe(false);
	});
});

describe("yInstructions", () => {
	const text = yInstructions();
	it("says Y never works on code and delegates to builders", () => {
		expect(text).toContain("You never change, run or read code yourself");
		expect(text).toContain("`agent` (role writer)");
	});
	it("tells Y not to wait for builders and to keep replies short", () => {
		expect(text).toContain("Do not wait for builders");
		expect(text).toContain(`never more than ${Y_REPLY_WORDS} words`);
	});
	it("tells Y to name builders and pull requests and to report events on their own line", () => {
		expect(text).toContain("pr:owner/repo#123");
		expect(text).toMatch(/^ {2}::finished build-1 fixed the form$/m);
	});
});

describe("appliedBuilderPatchBlock", () => {
	it("says what was applied", () => {
		expect(
			appliedBuilderPatchBlock({
				label: "2",
				files: 1,
				added: 3,
				removed: 1,
				path: "/p",
			}),
		).toBe(
			"Builder 2's changes (1 file, +3 −1) were applied to this thread's checkout; they are committed and published when your turn ends.",
		);
	});
	it("says why it was not applied and what to do", () => {
		const text = appliedBuilderPatchBlock({
			label: "2",
			files: 1,
			added: 3,
			removed: 1,
			path: "/p",
			failure: "patch failed",
		});
		expect(text).toContain("could not be applied");
		expect(text).toContain("patch failed");
		expect(text).toContain(
			"Start a builder to resolve it; the patch is at /p.",
		);
	});
});
