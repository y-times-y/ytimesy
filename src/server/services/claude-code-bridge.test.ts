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
	it("preserves the model tool ID across a bridge reset instead of assigning a new execution identity", async () => {
		const execute = vi.fn(
			async (_input: unknown, options: { toolCallId: string }) =>
				options.toolCallId,
		);
		for (let restart = 0; restart < 2; restart++) {
			const reply = requestClaudeCodeCall(
				"identity-turn",
				"probe",
				{},
				undefined,
				undefined,
				"toolu_stable_z9",
			);
			const [call] = takeClaudeCodeCalls("identity-turn");
			await runClaudeCodeCall("identity-turn", call, {
				tools: { probe: tool({ inputSchema: z.object({}), execute }) },
				onEvent: async () => undefined,
				signal: new AbortController().signal,
			});
			expect(await reply).toEqual({
				text: "ccmcp-toolu_stable_z9",
				isError: false,
			});
			closeClaudeCodeBridge("identity-turn");
		}
		// Identity transport only: this fake tool has no durable execution journal.
		expect(execute).toHaveBeenCalledTimes(2);
	});
	it("hands an image result to Claude as an image block, not its base64 as text", async () => {
		const viewer = tool({
			inputSchema: z.object({}),
			execute: async () => ({ path: "a.png", base64: "AAAA" }),
			toModelOutput: ({ output }) => ({
				type: "content",
				value: [
					{ type: "text", text: `Image ${output.path}` },
					{
						type: "file",
						data: { type: "data", data: output.base64 },
						mediaType: "image/png",
					},
				],
			}),
		});
		const turnId = "turn-image";
		const reply = requestClaudeCodeCall(turnId, "view_image", {});
		const [call] = takeClaudeCodeCalls(turnId);
		await runClaudeCodeCall(turnId, call, {
			tools: { view_image: viewer },
			onEvent: async () => undefined,
			signal: new AbortController().signal,
		});
		expect(await reply).toEqual({
			text: "",
			isError: false,
			content: [
				{ type: "text", text: "Image a.png" },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
			],
		});
		closeClaudeCodeBridge(turnId);
	});
	it("distinguishes a queued timeout from a started command with unknown outcome", async () => {
		vi.useFakeTimers();
		try {
			const queued = requestClaudeCodeCall(
				"timeout-queued",
				"bash",
				{ command: "printf queued" },
				20,
			);
			const active = requestClaudeCodeCall(
				"timeout-active",
				"bash",
				{ command: "printf active" },
				20,
			);
			expect(takeClaudeCodeCalls("timeout-active")).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(20);
			expect(await queued).toMatchObject({
				isError: true,
				text: expect.stringContaining("did not start"),
			});
			expect(pendingClaudeCodeCalls("timeout-queued")).toBe(0);
			expect(await active).toMatchObject({
				isError: true,
				text: expect.stringContaining("outcome is unknown"),
			});
		} finally {
			closeClaudeCodeBridge("timeout-queued");
			closeClaudeCodeBridge("timeout-active");
			vi.useRealTimers();
		}
	});
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
