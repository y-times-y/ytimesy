import { type ModelMessage, simulateReadableStream, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { runModelAgentStep } from "./model-agent-loop";

it("executes dependent composed reads in one inference while preserving leaf events and metrics", async () => {
	const events = vi.fn(async () => {});
	const metrics = vi.fn();
	const model = new MockLanguageModelV4({
		doStream: async () => ({
			stream: simulateReadableStream({
				initialDelayInMs: null,
				chunkDelayInMs: null,
				chunks: [
					{
						type: "tool-call",
						toolCallId: "compose",
						toolName: "compose_tools",
						input: JSON.stringify({
							steps: [
								{
									id: "first",
									tool: "read_file",
									arguments: { path: "a.ts" },
									dependsOn: [],
								},
								{
									id: "followup",
									tool: "read_file",
									arguments: {
										path: { $result: { step: "first", path: ["next"] } },
									},
									dependsOn: ["first"],
								},
							],
						}),
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
			}),
		}),
	});
	const read = vi.fn(async ({ path }: { path: string }) => ({
		path,
		next: "b.ts",
		content: "Exact retained source",
	}));
	const result = await runModelAgentStep(
		{
			userId: "owner",
			modelId: "model",
			instructions: "Inspect",
			messages: [{ role: "user", content: "Inspect" }],
			toolSurface: "implementation",
			tools: {
				read_file: tool({
					inputSchema: z.object({ path: z.string() }),
					execute: read,
				}),
			},
			signal: new AbortController().signal,
			onEvent: events,
			onStep: async () => {},
			onToolMetric: metrics,
		},
		{ model },
	);
	expect(model.doStreamCalls).toHaveLength(1);
	expect(read.mock.calls.map((call) => call[0].path)).toEqual(["a.ts", "b.ts"]);
	expect(JSON.stringify(result.messages)).toContain("Exact retained source");
	expect(events.mock.calls).toContainEqual([
		{
			type: "tool-result",
			id: "compose:step:followup",
			name: "read_file",
			output: { path: "b.ts", next: "b.ts", content: "Exact retained source" },
		},
	]);
	expect(
		metrics.mock.calls.filter(([metric]) => metric.tool_name === "read_file"),
	).toHaveLength(2);
});

it("executes independent ordinary tool calls concurrently in one model step", async () => {
	let release = () => {};
	const first = vi.fn(
		() =>
			new Promise((resolve) => {
				release = () => resolve({ content: "first source" });
			}),
	);
	const second = vi.fn(async () => ({ content: "second source" }));
	const model = new MockLanguageModelV4({
		doStream: async () => ({
			stream: simulateReadableStream({
				initialDelayInMs: null,
				chunkDelayInMs: null,
				chunks: [
					{
						type: "tool-call",
						toolCallId: "first",
						toolName: "read_file",
						input: '{"path":"first.ts"}',
					},
					{
						type: "tool-call",
						toolCallId: "second",
						toolName: "read_files",
						input: '{"paths":["second.ts"]}',
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
			}),
		}),
	});
	const pending = runModelAgentStep(
		{
			userId: "owner",
			modelId: "model",
			instructions: "Inspect independent sources",
			messages: [{ role: "user", content: "Inspect" }],
			toolSurface: "implementation",
			tools: {
				read_file: tool({
					inputSchema: z.object({ path: z.string() }),
					execute: first,
				}),
				read_files: tool({
					inputSchema: z.object({ paths: z.array(z.string()) }),
					execute: second,
				}),
			},
			signal: new AbortController().signal,
			onEvent: vi.fn(),
			onStep: vi.fn(),
		},
		{ model },
	);
	try {
		await vi.waitFor(() => {
			expect(first).toHaveBeenCalledOnce();
			expect(second).toHaveBeenCalledOnce();
		});
	} finally {
		release();
	}
	const result = await pending;
	expect(model.doStreamCalls).toHaveLength(1);
	expect(JSON.stringify(result.messages)).toContain("first source");
	expect(JSON.stringify(result.messages)).toContain("second source");
});

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
			prepared_prompt_characters: expect.any(Number),
			prepared_tool_characters: expect.any(Number),
		}),
	);
	expect(input.onModelMetric).toHaveBeenLastCalledWith(
		expect.objectContaining({ active_tools: 3 }),
	);
	expect(JSON.stringify(input.onModelMetric.mock.calls)).not.toContain(
		"Inspect",
	);
});
