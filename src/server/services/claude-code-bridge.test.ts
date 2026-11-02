import { tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	claudeCodeBridgeTools,
	closeClaudeCodeBridge,
	mcpToolDefinitions,
	pendingClaudeCodeCalls,
	publishClaudeCodeTools,
	requestClaudeCodeCall,
	runClaudeCodeCall,
	takeClaudeCodeCalls,
} from "./claude-code-bridge";

const tools = {
	agent: tool({
		description: "Start a helper.",
		inputSchema: z.object({ brief: z.string() }),
		execute: async ({ brief }) => ({ started: true, brief }),
	}),
	ask_user: tool({
		description: "Ask.",
		inputSchema: z.object({ question: z.string() }),
		execute: async () => ({ blocked: true, error: "No one to ask." }),
	}),
};

describe("Claude Code tool bridge", () => {
	it("offers the turn's tools once its step published them", async () => {
		const turnId = "turn-tools";
		const listing = claudeCodeBridgeTools(turnId, 5_000);
		publishClaudeCodeTools(turnId, await mcpToolDefinitions(tools));
		const listed = await listing;
		expect(listed?.map((entry) => entry.name)).toEqual(["agent", "ask_user"]);
		expect(listed?.[0]?.inputSchema).toMatchObject({
			type: "object",
			properties: { brief: { type: "string" } },
		});
		closeClaudeCodeBridge(turnId);
	});

	it("queues a call for the step, which runs it and answers", async () => {
		const turnId = "turn-call";
		const answer = requestClaudeCodeCall(turnId, "agent", { brief: "Look" });
		expect(pendingClaudeCodeCalls(turnId)).toBe(1);
		const onEvent = vi.fn(async (_event: { type: string }) => {});
		const [call] = takeClaudeCodeCalls(turnId);
		expect(call).toBeDefined();
		await runClaudeCodeCall(turnId, call as NonNullable<typeof call>, {
			tools,
			onEvent,
			signal: new AbortController().signal,
		});
		expect(await answer).toEqual({
			text: JSON.stringify({ started: true, brief: "Look" }),
			isError: false,
		});
		expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual([
			"tool-call",
			"tool-result",
		]);
		closeClaudeCodeBridge(turnId);
	});

	it("reports invalid arguments and refusals as errors", async () => {
		const turnId = "turn-errors";
		const invalid = requestClaudeCodeCall(turnId, "agent", { brief: 3 });
		const refused = requestClaudeCodeCall(turnId, "ask_user", {
			question: "?",
		});
		for (const call of takeClaudeCodeCalls(turnId))
			await runClaudeCodeCall(turnId, call, {
				tools,
				onEvent: async () => {},
				signal: new AbortController().signal,
			});
		expect((await invalid).isError).toBe(true);
		expect(await refused).toMatchObject({ isError: true });
		closeClaudeCodeBridge(turnId);
	});

	it("tells waiting calls when the turn ends", async () => {
		const turnId = "turn-ended";
		const answer = requestClaudeCodeCall(turnId, "agent", { brief: "x" });
		closeClaudeCodeBridge(turnId);
		expect(await answer).toEqual({
			text: "This turn has ended.",
			isError: true,
		});
	});

	it("answers a call nobody ran once its time is up", async () => {
		vi.useFakeTimers();
		const answer = requestClaudeCodeCall("turn-late", "agent", {}, 1_000);
		await vi.advanceTimersByTimeAsync(1_000);
		expect((await answer).isError).toBe(true);
		expect(pendingClaudeCodeCalls("turn-late")).toBe(0);
		vi.useRealTimers();
		closeClaudeCodeBridge("turn-late");
	});
});
