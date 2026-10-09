import { simulateReadableStream, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { runModelAgent } from "./model-agent-loop";

const usage = {
	inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 2, text: 2, reasoning: 0 },
};

it("lets a builder finish beyond 30 generations without replaying tools or losing checkpoints", async () => {
	let calls = 0;
	const execute = vi.fn(async () => ({ inspected: true }));
	const model = new MockLanguageModelV4({
		doStream: async () => {
			calls++;
			const ongoing = calls <= 32;
			return {
				stream: simulateReadableStream({
					initialDelayInMs: null,
					chunkDelayInMs: null,
					chunks: [
						...(ongoing
							? [
									{
										type: "tool-call" as const,
										toolCallId: `read-${calls}`,
										toolName: "read_file",
										input: "{}",
									},
								]
							: []),
						{
							type: "finish" as const,
							usage,
							finishReason: {
								unified: ongoing ? ("tool-calls" as const) : ("stop" as const),
								raw: ongoing ? "tool_calls" : "stop",
							},
						},
					],
				}),
			};
		},
	});
	const checkpoints: number[] = [];
	const messages = await runModelAgent(
		{
			userId: "fixture-owner",
			modelId: "fixture-model",
			toolSurface: "implementation",
			instructions: "Inspect the repository",
			messages: [{ role: "user", content: "Inspect" }],
			tools: { read_file: tool({ inputSchema: z.object({}), execute }) },
			signal: new AbortController().signal,
			onEvent: async () => {},
			onStep: async (history) => {
				checkpoints.push(history.length);
			},
		},
		{ model },
	);
	expect(calls).toBe(33);
	expect(execute).toHaveBeenCalledTimes(32);
	expect(checkpoints).toHaveLength(33);
	expect(
		messages.reduce(
			(count, message) =>
				count +
				(message.role === "tool"
					? message.content.filter((part) => part.type === "tool-result").length
					: 0),
			0,
		),
	).toBe(32);
});
