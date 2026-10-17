import {
	isStepCount,
	type LanguageModel,
	type ModelMessage,
	streamText,
	tool,
} from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ModelProvider } from "#/domain/model-connection";
import { runModelAgentStep } from "#/server/services/model-agent-loop";
import { connectedLanguageModel } from "./api-model";

/**
 * Each case runs the harness's durable tool loop shape against the real
 * provider adapter: one streamed step that calls a tool, a JSON checkpoint
 * (the api_turn.messages jsonb column), an injected runtime user message (what
 * afterTools hooks append mid-loop), then the next request. The next request
 * must carry the first response's reasoning in the provider's replay field.
 */

const sse = (events: unknown[], named = false) =>
	new Response(
		events
			.map((event) =>
				event === "[DONE]"
					? "data: [DONE]\n\n"
					: `${named ? `event: ${(event as { type: string }).type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
			)
			.join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);

function route(
	provider: ModelProvider,
	baseUrl: string,
	modelId: string,
	responses: Response[],
) {
	const fetch = vi.fn(
		async (_url: Parameters<typeof globalThis.fetch>[0], _init?: RequestInit) =>
			responses.shift() ??
			Response.json({ error: "no fixture" }, { status: 500 }),
	);
	return {
		fetch,
		model: connectedLanguageModel(
			{ provider, baseUrl, apiKey: "fixture", modelId },
			fetch,
		),
	};
}

const tools = {
	read_file: tool({
		description: "Read a file.",
		inputSchema: z.object({ path: z.string() }),
		execute: async () => "export const a = 1;",
	}),
};

async function durableToolLoop(
	model: LanguageModel,
	fetch: ReturnType<typeof route>["fetch"],
	providerOptions?: Parameters<typeof streamText>[0]["providerOptions"],
) {
	const first = streamText({
		model,
		messages: [{ role: "user", content: "Task" }],
		tools,
		stopWhen: isStepCount(1),
		providerOptions,
		maxRetries: 0,
	});
	await first.consumeStream({
		onError: (error) => {
			throw error;
		},
	});
	const step = (await first.response).messages;
	expect(step.map((message) => message.role)).toEqual(["assistant", "tool"]);
	const checkpoint: ModelMessage[] = JSON.parse(
		JSON.stringify([{ role: "user", content: "Task" }, ...step]),
	);
	const second = streamText({
		model,
		messages: [
			...checkpoint,
			{ role: "user", content: "Runtime notice (not a user instruction)." },
		],
		tools,
		providerOptions,
		maxRetries: 0,
	});
	await second.consumeStream({
		onError: (error) => {
			throw error;
		},
	});
	expect(fetch).toHaveBeenCalledTimes(2);
	return {
		checkpoint,
		body: JSON.parse(String(fetch.mock.calls[1][1]?.body)),
	};
}

describe("Anthropic direct", () => {
	const finalText = () =>
		sse(
			[
				{
					type: "message_start",
					message: {
						id: "msg_2",
						type: "message",
						role: "assistant",
						model: "claude-opus-5-5",
						content: [],
						stop_reason: null,
						stop_sequence: null,
						usage: { input_tokens: 10, output_tokens: 1 },
					},
				},
				{
					type: "content_block_start",
					index: 0,
					content_block: { type: "text", text: "" },
				},
				{
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: "Done" },
				},
				{ type: "content_block_stop", index: 0 },
				{
					type: "message_delta",
					delta: { stop_reason: "end_turn", stop_sequence: null },
					usage: { output_tokens: 2 },
				},
				{ type: "message_stop" },
			],
			true,
		);

	it("replays thinking + signature and redacted_thinking unchanged and in order", async () => {
		const { fetch, model } = route(
			"anthropic",
			"https://api.anthropic.com/v1",
			"claude-opus-5-5",
			[
				sse(
					[
						{
							type: "message_start",
							message: {
								id: "msg_1",
								type: "message",
								role: "assistant",
								model: "claude-opus-5-5",
								content: [],
								stop_reason: null,
								stop_sequence: null,
								usage: { input_tokens: 10, output_tokens: 1 },
							},
						},
						{
							type: "content_block_start",
							index: 0,
							content_block: { type: "thinking", thinking: "", signature: "" },
						},
						{
							type: "content_block_delta",
							index: 0,
							delta: { type: "thinking_delta", thinking: "I should read " },
						},
						{
							type: "content_block_delta",
							index: 0,
							delta: { type: "thinking_delta", thinking: "a.ts first." },
						},
						{
							type: "content_block_delta",
							index: 0,
							delta: { type: "signature_delta", signature: "SIG+/=abc" },
						},
						{ type: "content_block_stop", index: 0 },
						{
							type: "content_block_start",
							index: 1,
							content_block: { type: "redacted_thinking", data: "REDACTED+/=" },
						},
						{ type: "content_block_stop", index: 1 },
						{
							type: "content_block_start",
							index: 2,
							content_block: {
								type: "tool_use",
								id: "toolu_1",
								name: "read_file",
								input: {},
							},
						},
						{
							type: "content_block_delta",
							index: 2,
							delta: {
								type: "input_json_delta",
								partial_json: '{"path":"a.ts"}',
							},
						},
						{ type: "content_block_stop", index: 2 },
						{
							type: "message_delta",
							delta: { stop_reason: "tool_use", stop_sequence: null },
							usage: { output_tokens: 20 },
						},
						{ type: "message_stop" },
					],
					true,
				),
				finalText(),
			],
		);
		const { body } = await durableToolLoop(model, fetch);
		const assistant = body.messages.find(
			(message: { role: string }) => message.role === "assistant",
		);
		expect(assistant.content.slice(0, 3)).toEqual([
			{
				type: "thinking",
				thinking: "I should read a.ts first.",
				signature: "SIG+/=abc",
			},
			{ type: "redacted_thinking", data: "REDACTED+/=" },
			expect.objectContaining({
				type: "tool_use",
				id: "toolu_1",
				name: "read_file",
				input: { path: "a.ts" },
			}),
		]);
	});
});

describe("Google direct", () => {
	it("resends thought and function-call thoughtSignature exactly", async () => {
		const { fetch, model } = route(
			"google",
			"https://generativelanguage.googleapis.com/v1beta",
			"gemini-4-argon",
			[
				sse([
					{
						candidates: [
							{
								content: {
									role: "model",
									parts: [
										{
											text: "Need the file.",
											thought: true,
											thoughtSignature: "THOUGHT_SIG+/=",
										},
									],
								},
							},
						],
					},
					{
						candidates: [
							{
								content: {
									role: "model",
									parts: [
										{
											functionCall: {
												id: "fc-1",
												name: "read_file",
												args: { path: "a.ts" },
											},
											thoughtSignature: "CALL_SIG+/=",
										},
									],
								},
								finishReason: "STOP",
							},
						],
						usageMetadata: {
							promptTokenCount: 10,
							candidatesTokenCount: 5,
							totalTokenCount: 15,
						},
					},
				]),
				sse([
					{
						candidates: [
							{
								content: { role: "model", parts: [{ text: "Done" }] },
								finishReason: "STOP",
							},
						],
						usageMetadata: {
							promptTokenCount: 20,
							candidatesTokenCount: 1,
							totalTokenCount: 21,
						},
					},
				]),
			],
		);
		const { body } = await durableToolLoop(model, fetch);
		const modelTurn = body.contents.find(
			(content: { role: string }) => content.role === "model",
		);
		expect(modelTurn.parts).toEqual([
			expect.objectContaining({
				text: "Need the file.",
				thought: true,
				thoughtSignature: "THOUGHT_SIG+/=",
			}),
			expect.objectContaining({
				functionCall: { id: "fc-1", name: "read_file", args: { path: "a.ts" } },
				thoughtSignature: "CALL_SIG+/=",
			}),
		]);
	});
});

const responsesFixture = (output: "tool" | "text") => {
	const response = {
		id: `resp_${output}`,
		object: "response",
		created_at: 1,
		status: "in_progress",
		model: "gpt-6.1-sol",
		output: [],
		usage: null,
	};
	const completed = {
		...response,
		status: "completed",
		usage: {
			input_tokens: 10,
			input_tokens_details: { cached_tokens: 0 },
			output_tokens: 5,
			output_tokens_details: { reasoning_tokens: 3 },
			total_tokens: 15,
		},
	};
	if (output === "text") {
		const message = {
			type: "message",
			id: "msg_2",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "Done", annotations: [] }],
		};
		return sse([
			{ type: "response.created", response, sequence_number: 0 },
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { ...message, status: "in_progress", content: [] },
				sequence_number: 1,
			},
			{
				type: "response.output_text.delta",
				item_id: "msg_2",
				output_index: 0,
				content_index: 0,
				delta: "Done",
				logprobs: [],
				sequence_number: 2,
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: message,
				sequence_number: 3,
			},
			{
				type: "response.completed",
				response: { ...completed, output: [message] },
				sequence_number: 4,
			},
		]);
	}
	const reasoning = {
		type: "reasoning",
		id: "rs_1",
		encrypted_content: "ENCRYPTED+/=",
		summary: [{ type: "summary_text", text: "Read a.ts." }],
	};
	const call = {
		type: "function_call",
		id: "fc_1",
		call_id: "call_1",
		name: "read_file",
		arguments: '{"path":"a.ts"}',
		status: "completed",
	};
	return sse([
		{ type: "response.created", response, sequence_number: 0 },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: {
				type: "reasoning",
				id: "rs_1",
				encrypted_content: null,
				summary: [],
			},
			sequence_number: 1,
		},
		{
			type: "response.reasoning_summary_part.added",
			item_id: "rs_1",
			output_index: 0,
			summary_index: 0,
			part: { type: "summary_text", text: "" },
			sequence_number: 2,
		},
		{
			type: "response.reasoning_summary_text.delta",
			item_id: "rs_1",
			output_index: 0,
			summary_index: 0,
			delta: "Read a.ts.",
			sequence_number: 3,
		},
		{
			type: "response.output_item.done",
			output_index: 0,
			item: reasoning,
			sequence_number: 4,
		},
		{
			type: "response.output_item.added",
			output_index: 1,
			item: { ...call, arguments: "", status: "in_progress" },
			sequence_number: 5,
		},
		{
			type: "response.function_call_arguments.delta",
			item_id: "fc_1",
			output_index: 1,
			delta: '{"path":"a.ts"}',
			sequence_number: 6,
		},
		{
			type: "response.output_item.done",
			output_index: 1,
			item: call,
			sequence_number: 7,
		},
		{
			type: "response.completed",
			response: { ...completed, output: [reasoning, call] },
			sequence_number: 8,
		},
	]);
};

describe("OpenAI Responses (direct and Codex subscription)", () => {
	it("passes back encrypted reasoning items with store:false", async () => {
		const { fetch, model } = route(
			"openai",
			"https://api.openai.com/v1",
			"gpt-6.1-sol",
			[responsesFixture("tool"), responsesFixture("text")],
		);
		const { body } = await durableToolLoop(model, fetch, {
			openai: { store: false, include: ["reasoning.encrypted_content"] },
		});
		expect(body.store).toBe(false);
		expect(body.include).toContain("reasoning.encrypted_content");
		const index = body.input.findIndex(
			(item: { type?: string }) => item.type === "reasoning",
		);
		expect(body.input[index]).toEqual({
			type: "reasoning",
			id: "rs_1",
			encrypted_content: "ENCRYPTED+/=",
			summary: [{ type: "summary_text", text: "Read a.ts." }],
		});
		expect(body.input[index + 1]).toMatchObject({
			type: "function_call",
			call_id: "call_1",
		});
	});

	it("requests encrypted reasoning on the subscription settings (store:false without include)", async () => {
		const { fetch, model } = route(
			"openai",
			"https://chatgpt.com/backend-api/codex",
			"gpt-6.1-sol",
			[responsesFixture("tool"), responsesFixture("text")],
		);
		const { body } = await durableToolLoop(model, fetch, {
			openai: {
				store: false,
				reasoningEffort: "high",
				reasoningSummary: "auto",
			},
		});
		expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).include).toContain(
			"reasoning.encrypted_content",
		);
		expect(
			body.input.find((item: { type?: string }) => item.type === "reasoning")
				.encrypted_content,
		).toBe("ENCRYPTED+/=");
	});
});

const chatChunk = (model: string, delta: unknown, finish?: string) => ({
	id: "gen-1",
	object: "chat.completion.chunk",
	created: 1,
	model,
	choices: [{ index: 0, delta, finish_reason: finish ?? null }],
	...(finish
		? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
		: {}),
});

function openRouterToolStep(
	model: string,
	details: Array<Record<string, unknown>>,
	reasoningText: string[],
) {
	return sse([
		...details.map((detail, index) =>
			chatChunk(model, {
				role: "assistant",
				content: "",
				...(reasoningText[index] ? { reasoning: reasoningText[index] } : {}),
				reasoning_details: [detail],
			}),
		),
		chatChunk(model, {
			tool_calls: [
				{
					index: 0,
					id: "call_1",
					type: "function",
					function: { name: "read_file", arguments: '{"path":"a.ts"}' },
				},
			],
		}),
		chatChunk(model, {}, "tool_calls"),
		"[DONE]",
	]);
}

const openRouterText = (model: string) =>
	sse([
		chatChunk(model, { content: "Done" }),
		chatChunk(model, {}, "stop"),
		"[DONE]",
	]);

describe("OpenRouter chat completions", () => {
	it.each([
		["deepseek/deepseek-v4.1-flash", "unknown"],
		["deepseek/deepseek-v4-pro-0813", "unknown"],
		["z-ai/glm-5.3", "unknown"],
		["moonshotai/kimi-k3", "unknown"],
	])(
		"%s: replays streamed reasoning complete and in order as reasoning + reasoning_details",
		async (modelId, format) => {
			const deltas = [
				{ type: "reasoning.text", text: "First I ", format, index: 0 },
				{ type: "reasoning.text", text: "read a.ts.", format, index: 0 },
			];
			const { fetch, model } = route(
				"openrouter",
				"https://openrouter.ai/api/v1",
				modelId,
				[
					openRouterToolStep(modelId, deltas, ["First I ", "read a.ts."]),
					openRouterText(modelId),
				],
			);
			const { body } = await durableToolLoop(model, fetch);
			const assistant = body.messages.find(
				(message: { role: string }) => message.role === "assistant",
			);
			expect(assistant.reasoning).toBe("First I read a.ts.");
			expect(assistant.reasoning_details).toEqual([
				{
					type: "reasoning.text",
					text: "First I read a.ts.",
					format,
					index: 0,
				},
			]);
			expect(assistant.tool_calls[0].id).toBe("call_1");
		},
	);

	it.each([
		["anthropic/claude-opus-5.5", "anthropic-claude-v1"],
		["google/gemini-4-argon", "google-gemini-v1"],
	])(
		"%s: replays signed reasoning_details unchanged",
		async (modelId, format) => {
			const deltas = [
				{ type: "reasoning.text", text: "Read ", format, index: 0 },
				{
					type: "reasoning.text",
					text: "a.ts.",
					signature: "SIG+/=",
					format,
					index: 0,
				},
				{ type: "reasoning.encrypted", data: "OPAQUE+/=", format, index: 1 },
			];
			const { fetch, model } = route(
				"openrouter",
				"https://openrouter.ai/api/v1",
				modelId,
				[
					openRouterToolStep(modelId, deltas, ["Read ", "a.ts."]),
					openRouterText(modelId),
				],
			);
			const { body } = await durableToolLoop(model, fetch);
			const assistant = body.messages.find(
				(message: { role: string }) => message.role === "assistant",
			);
			expect(assistant.reasoning_details).toEqual([
				{
					type: "reasoning.text",
					text: "Read a.ts.",
					signature: "SIG+/=",
					format,
					index: 0,
				},
				{ type: "reasoning.encrypted", data: "OPAQUE+/=", format, index: 1 },
			]);
		},
	);
});

describe("Direct OpenAI-compatible chat completions", () => {
	it.each([
		["https://api.deepseek.com/v1", "deepseek-v4-flash"],
		["https://api.z.ai/api/paas/v4", "glm-5.3"],
		["https://api.moonshot.ai/v1", "kimi-k3"],
	])(
		"%s %s: replays streamed reasoning_content complete and in order",
		async (baseUrl, modelId) => {
			const { fetch, model } = route("compatible", baseUrl, modelId, [
				sse([
					chatChunk(modelId, {
						role: "assistant",
						reasoning_content: "First I ",
					}),
					chatChunk(modelId, { reasoning_content: "read a.ts." }),
					chatChunk(modelId, {
						tool_calls: [
							{
								index: 0,
								id: "call_1",
								type: "function",
								function: { name: "read_file", arguments: '{"path":"a.ts"}' },
							},
						],
					}),
					chatChunk(modelId, {}, "tool_calls"),
					"[DONE]",
				]),
				openRouterText(modelId),
			]);
			const { body } = await durableToolLoop(model, fetch);
			const assistant = body.messages.find(
				(message: { role: string }) => message.role === "assistant",
			);
			expect(assistant.reasoning_content).toBe("First I read a.ts.");
			expect(assistant.tool_calls[0].id).toBe("call_1");
		},
	);
});

/** The same replay through the harness's own durable step runner, not bare SDK calls. */
describe("harness durable steps (runModelAgentStep)", () => {
	async function harnessSteps(
		model: LanguageModel,
		fetch: ReturnType<typeof route>["fetch"],
		requestSettings?: (instructions: string) => {
			system?: string;
			providerOptions?: Parameters<typeof streamText>[0]["providerOptions"];
		},
	) {
		let saved: ModelMessage[] = [{ role: "user", content: "Task" }];
		for (let index = 0; index < 2; index++) {
			const result = await runModelAgentStep(
				{
					userId: "alice",
					modelId: "fixture",
					messages: saved,
					instructions: "Work.",
					knownTools: ["read_file"],
					tools,
					signal: new AbortController().signal,
					onStep: async () => {},
					onEvent: async () => {},
				},
				{ model, requestSettings },
			);
			// api_turn.messages is a jsonb column.
			saved = JSON.parse(JSON.stringify(result.messages));
		}
		expect(fetch).toHaveBeenCalledTimes(2);
		return JSON.parse(String(fetch.mock.calls[1][1]?.body));
	}

	it("Anthropic thinking signature survives a checkpointed step", async () => {
		const { fetch, model } = route(
			"anthropic",
			"https://api.anthropic.com/v1",
			"claude-opus-5-5",
			[
				sse(
					[
						{
							type: "message_start",
							message: {
								id: "msg_1",
								type: "message",
								role: "assistant",
								model: "claude-opus-5-5",
								content: [],
								stop_reason: null,
								stop_sequence: null,
								usage: { input_tokens: 10, output_tokens: 1 },
							},
						},
						{
							type: "content_block_start",
							index: 0,
							content_block: { type: "thinking", thinking: "", signature: "" },
						},
						{
							type: "content_block_delta",
							index: 0,
							delta: { type: "thinking_delta", thinking: "Read a.ts." },
						},
						{
							type: "content_block_delta",
							index: 0,
							delta: { type: "signature_delta", signature: "SIG+/=" },
						},
						{ type: "content_block_stop", index: 0 },
						{
							type: "content_block_start",
							index: 1,
							content_block: {
								type: "tool_use",
								id: "toolu_1",
								name: "read_file",
								input: {},
							},
						},
						{
							type: "content_block_delta",
							index: 1,
							delta: {
								type: "input_json_delta",
								partial_json: '{"path":"a.ts"}',
							},
						},
						{ type: "content_block_stop", index: 1 },
						{
							type: "message_delta",
							delta: { stop_reason: "tool_use", stop_sequence: null },
							usage: { output_tokens: 20 },
						},
						{ type: "message_stop" },
					],
					true,
				),
				sse(
					[
						{
							type: "message_start",
							message: {
								id: "msg_2",
								type: "message",
								role: "assistant",
								model: "claude-opus-5-5",
								content: [],
								stop_reason: null,
								stop_sequence: null,
								usage: { input_tokens: 10, output_tokens: 1 },
							},
						},
						{
							type: "content_block_start",
							index: 0,
							content_block: { type: "text", text: "" },
						},
						{
							type: "content_block_delta",
							index: 0,
							delta: { type: "text_delta", text: "Done" },
						},
						{ type: "content_block_stop", index: 0 },
						{
							type: "message_delta",
							delta: { stop_reason: "end_turn", stop_sequence: null },
							usage: { output_tokens: 2 },
						},
						{ type: "message_stop" },
					],
					true,
				),
			],
		);
		const body = await harnessSteps(model, fetch);
		const assistant = body.messages.find(
			(message: { role: string }) => message.role === "assistant",
		);
		expect(assistant.content[0]).toEqual({
			type: "thinking",
			thinking: "Read a.ts.",
			signature: "SIG+/=",
		});
	});

	it("OpenAI Responses encrypted reasoning survives a checkpointed step", async () => {
		const { fetch, model } = route(
			"openai",
			"https://chatgpt.com/backend-api/codex",
			"gpt-6.1-sol",
			[responsesFixture("tool"), responsesFixture("text")],
		);
		const body = await harnessSteps(model, fetch, (instructions) => ({
			providerOptions: { openai: { instructions, store: false } },
		}));
		expect(
			body.input.find((item: { type?: string }) => item.type === "reasoning"),
		).toEqual({
			type: "reasoning",
			id: "rs_1",
			encrypted_content: "ENCRYPTED+/=",
			summary: [{ type: "summary_text", text: "Read a.ts." }],
		});
	});

	it("OpenRouter DeepSeek reasoning survives a checkpointed step", async () => {
		const modelId = "deepseek/deepseek-v4.1-flash";
		const { fetch, model } = route(
			"openrouter",
			"https://openrouter.ai/api/v1",
			modelId,
			[
				openRouterToolStep(
					modelId,
					[
						{
							type: "reasoning.text",
							text: "First I ",
							format: "unknown",
							index: 0,
						},
						{
							type: "reasoning.text",
							text: "read a.ts.",
							format: "unknown",
							index: 0,
						},
					],
					["First I ", "read a.ts."],
				),
				openRouterText(modelId),
			],
		);
		const body = await harnessSteps(model, fetch);
		const assistant = body.messages.find(
			(message: { role: string }) => message.role === "assistant",
		);
		expect(assistant.reasoning).toBe("First I read a.ts.");
		expect(assistant.reasoning_details).toEqual([
			{
				type: "reasoning.text",
				text: "First I read a.ts.",
				format: "unknown",
				index: 0,
			},
		]);
	});
});
