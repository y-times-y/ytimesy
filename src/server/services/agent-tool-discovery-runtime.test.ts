import { type ModelMessage, simulateReadableStream, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { runModelAgentStep } from "./model-agent-loop";

it("executes SDK discovery, checkpoints the match and exposes it after a durable restart", async () => {
	const model = new MockLanguageModelV4({
		doStream: async () => ({
			stream: simulateReadableStream({
				chunks: [
					{
						type: "tool-call",
						toolCallId: "discover",
						toolName: "search_tools",
						input: '{"query":"screenshot"}',
					},
					{
						type: "finish",
						finishReason: { unified: "tool-calls", raw: "tool_calls" },
						usage: {
							inputTokens: {
								total: 3,
								noCache: 3,
								cacheRead: 0,
								cacheWrite: 0,
							},
							outputTokens: { total: 2, text: 2, reasoning: 0 },
						},
					},
				],
				initialDelayInMs: null,
				chunkDelayInMs: null,
			}),
		}),
	});
	const input = {
		userId: "owner",
		modelId: "model",
		instructions: "Work",
		messages: [{ role: "user", content: "Inspect" }] as ModelMessage[],
		tools: {
			read_file: tool({
				inputSchema: z.object({}),
				execute: async () => "data",
			}),
			browser_screenshot: tool({
				description: "Capture a screenshot",
				inputSchema: z.object({}),
				execute: async () => "image",
			}),
		},
		signal: new AbortController().signal,
		onEvent: vi.fn(),
		onStep: vi.fn(),
		onToolMetric: vi.fn(),
		onModelMetric: vi.fn(),
	};
	const first = await runModelAgentStep(input, { model });
	expect(model.doStreamCalls[0].tools?.map((item) => item.name)).toEqual([
		"read_file",
		"search_tools",
	]);
	expect(JSON.stringify(first.messages)).toContain(
		'"name":"browser_screenshot"',
	);
	await runModelAgentStep({ ...input, messages: first.messages }, { model });
	expect(model.doStreamCalls[1].tools?.map((item) => item.name)).toEqual([
		"read_file",
		"browser_screenshot",
		"search_tools",
	]);
	expect(input.onToolMetric).toHaveBeenCalledWith(
		expect.objectContaining({
			tool_name: "search_tools",
			category: "discovery",
			outcome: "completed",
		}),
	);
	expect(input.onModelMetric).toHaveBeenCalledWith(
		expect.objectContaining({
			active_tools: 2,
			input_tokens: 3,
			output_tokens: 2,
			outcome: "tool_calls",
		}),
	);
	expect(input.onModelMetric).toHaveBeenLastCalledWith(
		expect.objectContaining({ active_tools: 3 }),
	);
	expect(JSON.stringify(input.onModelMetric.mock.calls)).not.toContain(
		"Inspect",
	);
});
