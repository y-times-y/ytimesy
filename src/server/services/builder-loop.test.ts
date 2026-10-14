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

it("shows a server-side search known only from its cited sources as one search", async () => {
	const model = new MockLanguageModelV4({
		doStream: async () => ({
			stream: simulateReadableStream({
				initialDelayInMs: null,
				chunkDelayInMs: null,
				chunks: [
					{ type: "text-start" as const, id: "t" },
					{ type: "text-delta" as const, id: "t", delta: "zod 4.6.7" },
					{ type: "text-end" as const, id: "t" },
					...[
						"https://www.npmjs.com/package/zod",
						"https://www.npmjs.com/package/zod",
						"https://github.com/colinhacks/zod/releases",
					].map((url, index) => ({
						type: "source" as const,
						sourceType: "url" as const,
						id: `s${index}`,
						url,
					})),
					{
						type: "finish" as const,
						usage,
						finishReason: { unified: "stop" as const, raw: "stop" },
					},
				],
			}),
		}),
	});
	const events: unknown[] = [];
	await runModelAgent(
		{
			userId: "fixture-owner",
			modelId: "fixture-model",
			toolSurface: "implementation",
			instructions: "Answer",
			messages: [{ role: "user", content: "Latest zod?" }],
			tools: {},
			signal: new AbortController().signal,
			onEvent: async (event) => {
				if ("name" in event) events.push(event);
			},
			onStep: async () => {},
		},
		{ model },
	);
	expect(events).toEqual([
		{
			type: "tool-call",
			id: "cited-search-0",
			name: "web_search",
			input: { sources: 2 },
		},
		{
			type: "tool-result",
			id: "cited-search-0",
			name: "web_search",
			output: {
				sources: [
					{ url: "https://www.npmjs.com/package/zod" },
					{ url: "https://github.com/colinhacks/zod/releases" },
				],
			},
		},
	]);
});
