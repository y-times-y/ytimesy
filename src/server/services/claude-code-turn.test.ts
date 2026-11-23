import type { ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
	CLAUDE_CODE_INBOX_CALL,
	closeClaudeCodeBridge,
	pendingClaudeCodeCalls,
	requestClaudeCodeCall,
} from "./claude-code-bridge";
import { runClaudeCodeStep, stopClaudeCodeRun } from "./claude-code-runner";

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
	claudeCodeSentMessagesText,
	leavesClaudeCodeRunning,
	runClaudeCodeTurnStep,
	stopClaudeCodeTurnRun,
	withMessagesSentDuringRun,
} from "./claude-code-turn";

describe("messages sent while a Claude Code run works", () => {
	it("the step answers the run's inbox call with the turn's sent messages, as no tool call", async () => {
		const turnId = "inbox-turn";
		const onEvent = vi.fn(async () => {});
		const inbox = vi.fn(async () => "The user sent this message: use pnpm");
		let answer: unknown;
		vi.mocked(runClaudeCodeStep).mockImplementationOnce(async (step) => {
			const asked = requestClaudeCodeCall(turnId, CLAUDE_CODE_INBOX_CALL, {});
			step.bridge.pump();
			answer = await asked;
			return { messages: [], outcome: "completed" };
		});
		await runClaudeCodeTurnStep({
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
			onEvent,
			onPlan: () => {},
			inbox,
		} as unknown as Parameters<typeof runClaudeCodeTurnStep>[0]);
		expect(answer).toEqual({
			text: "The user sent this message: use pnpm",
			isError: false,
		});
		expect(inbox).toHaveBeenCalledOnce();
		// Not a tool call: nothing shows in the timeline for it.
		expect(onEvent).not.toHaveBeenCalled();
	});

	it("keeps them before the run's answer, so the next run does not send them again", () => {
		const before = [{ role: "user" as const, content: "Build it" }];
		const sent = [{ role: "user" as const, content: "Use pnpm" }];
		const answer = { role: "assistant" as const, content: "Built with pnpm." };
		expect(withMessagesSentDuringRun([...before, answer], sent)).toEqual([
			...before,
			...sent,
			answer,
		]);
		// A step that yields (the run goes on) keeps them at the end.
		expect(withMessagesSentDuringRun(before, sent)).toEqual([
			...before,
			...sent,
		]);
		expect(withMessagesSentDuringRun(before, [])).toEqual(before);
	});

	it("tells the model the user's message wins over its plan", () => {
		expect(claudeCodeSentMessagesText([])).toBe("");
		const text = claudeCodeSentMessagesText([
			{ role: "user", content: "Use pnpm" },
		]);
		expect(text).toContain("while you were working");
		expect(text).toContain("the user's message wins");
		expect(text.endsWith("Use pnpm")).toBe(true);
	});
});

describe("leavesClaudeCodeRunning", () => {
	it("lets Claude Code keep running when a deploy cut the step's connection first (2026-11-23)", () => {
		expect(
			leavesClaudeCodeRunning([
				new Error("Network connection lost."),
				undefined,
			]),
		).toBe(true);
		const reset = Object.assign(new Error("read ECONNRESET"), {
			code: "ECONNRESET",
		});
		expect(
			leavesClaudeCodeRunning([
				new TypeError("fetch failed", { cause: reset }),
				undefined,
			]),
		).toBe(true);
		expect(leavesClaudeCodeRunning([new Error("Model run cancelled")])).toBe(
			false,
		);
	});

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

describe("stopping a remote Claude process", () => {
	it("sends cancellation to AWS even when there is no Freestyle VM", async () => {
		const fetcher = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				new Response(
					JSON.stringify({ exitCode: 0, stdout: "stopped", stderr: "" }),
				),
		);
		vi.stubGlobal("fetch", fetcher);
		vi.mocked(stopClaudeCodeRun).mockImplementationOnce(async (shell) => {
			await shell("printf stop", 1000);
		});
		try {
			await stopClaudeCodeTurnRun({
				machines: {} as never,
				vm: null,
				turnId: "22222222-2222-4222-8222-222222222222",
				runner: { baseUrl: "https://runner-z.example", secret: "z".repeat(40) },
			});
			expect(fetcher).toHaveBeenCalledOnce();
			expect(String(fetcher.mock.calls[0]?.[0])).toBe(
				"https://runner-z.example/exec",
			);
		} finally {
			vi.unstubAllGlobals();
		}
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

	it("on the chat's machine exposes tracked workspace tools, code mode and the plan tool", () => {
		expect(Object.keys(claudeCodeBridgeToolSet(tools, ["web_fetch"]))).toEqual([
			"read",
			"bash",
			"agent",
			"run_code",
			"update_plan",
		]);
	});

	it("on a runner box offers the file and shell tools, run_code and the plan tool", () => {
		expect(
			Object.keys(claudeCodeBridgeToolSet(tools, ["web_fetch"], true)).sort(),
		).toEqual(["agent", "bash", "read", "run_code", "update_plan"]);
	});
});
