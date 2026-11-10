import type { ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
	closeClaudeCodeBridge,
	pendingClaudeCodeCalls,
	requestClaudeCodeCall,
} from "./claude-code-bridge";
import { runClaudeCodeStep } from "./claude-code-runner";

vi.mock("./claude-code-runner", () => ({
	runClaudeCodeStep: vi.fn(),
	stopClaudeCodeRun: vi.fn(),
}));
vi.mock("../adapters/github/git-proxy-transfer", () => ({
	gitProxyConfiguration: () => ({
		origin: "https://edge.example",
		secret: "test-only-grant-secret",
	}),
}));
vi.mock("../adapters/claude-subscription", () => ({
	claudeSubscriptionTokenForRedaction: async () => null,
}));

import {
	claudeCodeBridgeToolSet,
	leavesClaudeCodeRunning,
	runClaudeCodeTurnStep,
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

describe("interrupted Claude step bridge lifecycle", () => {
	it.each([
		["Durable Object reset because its code was updated.", true],
		["Durable Object's isolate exceeded its memory limit and was reset", true],
		["Stopped by the user.", false],
	])(
		"%s preserves queued calls only for resumable resets",
		async (message, survives) => {
			const turnId = `lifecycle-${message}`;
			const failure = new Error(message);
			let answer: Promise<unknown> | undefined;
			vi.mocked(runClaudeCodeStep).mockImplementationOnce(async () => {
				answer = requestClaudeCodeCall(turnId, "bash", {
					command: "printf example",
				});
				throw failure;
			});
			const input = {
				userId: "u",
				sessionId: "s",
				turnId,
				modelId: "claude-test",
				agentRole: null,
				workspace: async () => ({ vm: "vm-test", cwd: "/repo" }),
				machines: {},
				messages: [],
				tools: {},
				deadline: Date.now() + 1000,
				signal: new AbortController().signal,
				redact: () => [],
				addRedaction: () => {},
				hasItem: () => false,
				toolName: () => undefined,
				onEvent: async () => {},
				onPlan: () => {},
			} as unknown as Parameters<typeof runClaudeCodeTurnStep>[0];
			try {
				await expect(runClaudeCodeTurnStep(input)).rejects.toBe(failure);
				expect(pendingClaudeCodeCalls(turnId)).toBe(survives ? 1 : 0);
			} finally {
				closeClaudeCodeBridge(turnId);
				await answer;
			}
		},
	);
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

	it("on the chat's machine exposes tracked workspace tools and code mode, never a second plan tool", () => {
		expect(Object.keys(claudeCodeBridgeToolSet(tools, ["web_fetch"]))).toEqual([
			"read",
			"bash",
			"agent",
			"run_code",
		]);
	});

	it("on a runner box offers the file and shell tools and run_code, never our plan tool", () => {
		expect(
			Object.keys(claudeCodeBridgeToolSet(tools, ["web_fetch"], true)).sort(),
		).toEqual(["agent", "bash", "read", "run_code"]);
	});
});
