import type { ModelMessage } from "ai";
import { streamText } from "ai";
import { describe, expect, it, vi } from "vitest";
import { atifTrajectory, type TimedEvent } from "../evals/harbor_v2/atif";
import { harborBridgeConfig } from "../evals/harbor_v2/config";
import {
	BEDROCK_MAX_OUTPUT_TOKENS,
	contextManagementFallback,
	harborRuntime,
} from "../evals/harbor_v2/runtime";
import { describeRuntime } from "../evals/harbor_v2/runtime-description";
import {
	guardedLanguageModel,
	SpendCapReached,
	trialSpendGuard,
} from "../evals/harbor_v2/spend";
import type { ApiAgentEvent } from "../src/domain/api-agent-event";
import type { ApiTokenUsage } from "../src/domain/api-token-usage";
import { usageCostUsd } from "../src/domain/model-pricing";
import { modelContextBudget } from "../src/server/services/api-agent-context";
import { runModelAgent } from "../src/server/services/model-agent-loop";

// A run never reads the public catalog (model-context-windows.ts).
vi.mock("../src/server/adapters/browse-models", () => ({
	browseModels: async () => {
		throw new Error("The bedrock route must not read the model catalog.");
	},
}));

// Fake, well-formed keys: never real credentials.
const AWS = {
	AWS_ACCESS_KEY_ID: "AKIAFAKEFAKEFAKE1234",
	AWS_SECRET_ACCESS_KEY: "fake/secret/for/tests/only",
};
const env = {
	YTIMESY_HARBOR_ROUTE: "bedrock",
	YTIMESY_HARBOR_APPROVED: "bedrock",
	YTIMESY_HARBOR_TOTAL_USD_CAP: "1",
	YTIMESY_HARBOR_TRIAL_USD_CAP: "0.5",
	YTIMESY_HARBOR_SPEND_LEDGER: "/tmp/bedrock-ledger.jsonl",
	YTIMESY_HARBOR_MODEL: "openai.gpt-6-astra",
};
const MANTLE = "https://bedrock-mantle.us-east-1.api.aws/openai/v1";

type Sent = { url: string; headers: Headers; body: Record<string, unknown> };

const responseUsage = (input: number, output: number) => ({
	input_tokens: input,
	input_tokens_details: { cached_tokens: 0 },
	output_tokens: output,
	output_tokens_details: { reasoning_tokens: 0 },
	total_tokens: input + output,
});
const responseBase = {
	object: "response",
	created_at: 1,
	model: "openai.gpt-6-astra",
	status: "completed",
};
/** The live V1 shape (mantle, 2026-10-28): one compaction item and usage. */
const compacted = (status = 200) =>
	status === 200
		? Response.json({
				id: "resp_compact",
				...responseBase,
				output: [
					{
						type: "compaction",
						id: "cmp_1",
						encrypted_content: "encrypted-checkpoint",
					},
				],
				usage: responseUsage(15_278, 142),
			})
		: Response.json(
				{ error: { message: "upstream failure", type: "server_error" } },
				{ status },
			);
const sse = (events: object[]) =>
	new Response(
		events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);
/** A streamed final answer. */
const answer = (text: string, input = 2_000) => {
	const message = {
		type: "message",
		id: "msg_1",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text, annotations: [] }],
	};
	const response = {
		id: "resp_1",
		...responseBase,
		output: [message],
		usage: responseUsage(input, 20),
	};
	return sse([
		{
			type: "response.created",
			sequence_number: 0,
			response: {
				...response,
				status: "in_progress",
				output: [],
				usage: null,
			},
		},
		{
			type: "response.output_item.added",
			sequence_number: 1,
			output_index: 0,
			item: { ...message, status: "in_progress", content: [] },
		},
		{
			type: "response.output_text.delta",
			sequence_number: 2,
			item_id: "msg_1",
			output_index: 0,
			content_index: 0,
			delta: text,
			logprobs: [],
		},
		{
			type: "response.output_item.done",
			sequence_number: 3,
			output_index: 0,
			item: message,
		},
		{ type: "response.completed", sequence_number: 4, response },
	]);
};
/** A non-streamed summary (the harness's own compaction). */
const summary = () =>
	Response.json({
		id: "resp_summary",
		...responseBase,
		output: [
			{
				type: "message",
				id: "msg_s",
				role: "assistant",
				status: "completed",
				content: [
					{
						type: "output_text",
						text: "## Requirements and constraints\n- Solve the task",
						annotations: [],
					},
				],
			},
		],
		usage: responseUsage(3_000, 60),
	});

function recordingFetch(compactStatus = 200) {
	const sent: Sent[] = [];
	const fetch: typeof globalThis.fetch = async (url, init) => {
		const body = JSON.parse(String(init?.body));
		sent.push({ url: String(url), headers: new Headers(init?.headers), body });
		if (String(url).endsWith("/responses/compact"))
			return compacted(compactStatus);
		return body.stream ? answer("Done.") : summary();
	};
	return { sent, fetch };
}

/** A tool-call history with encrypted reasoning, as the Responses route keeps it. */
const toolHistory: ModelMessage[] = [
	{ role: "user", content: "Solve the task" },
	{
		role: "assistant",
		content: [
			{
				type: "reasoning",
				text: "Look first.",
				providerOptions: {
					openai: { itemId: "rs_1", reasoningEncryptedContent: "enc-rs-1" },
				},
			},
			{
				type: "tool-call",
				toolCallId: "call_1",
				toolName: "bash",
				input: { command: "ls" },
				providerOptions: { openai: { itemId: "fc_1" } },
			},
		],
	},
	{
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId: "call_1",
				toolName: "bash",
				output: { type: "text", value: `solution.py\n${"x".repeat(12_000)}` },
			},
		],
	},
];

async function bedrockRuntime(
	fetch: typeof globalThis.fetch,
	extraEnv: Record<string, string> = {},
	wrapModel = (model: import("ai").LanguageModel) => model,
) {
	const config = harborBridgeConfig({ ...env, ...extraEnv });
	const runtime = await harborRuntime({
		config,
		env: AWS,
		userId: "harbor",
		cacheScope: "trial-1",
		wrapModel,
		fetch,
	});
	return { config, runtime };
}

describe("OpenAI native compaction on the Bedrock route", () => {
	it("is on by default: V2 in-stream context_management on every request, below the loop's threshold", async () => {
		const { sent, fetch } = recordingFetch();
		const { config, runtime } = await bedrockRuntime(fetch);
		expect(config.bedrock?.nativeCompaction).toBe(true);
		expect(runtime.compact).toBeTypeOf("function");
		expect(runtime.compactFallback).toBe(true);
		const result = streamText({
			model: runtime.model,
			messages: [
				...toolHistory,
				{
					role: "assistant",
					content: [
						{
							type: "custom",
							kind: "openai.compaction",
							providerOptions: {
								openai: { itemId: "cmp_0", encryptedContent: "enc-cmp-0" },
							},
						},
					],
				},
			],
			...runtime.requestSettings?.("Work."),
		});
		await result.consumeStream();
		const [request] = sent;
		expect(request.url).toBe(`${MANTLE}/responses`);
		expect(request.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /);
		const threshold = Math.floor(
			modelContextBudget({
				contextWindow: 1_050_000,
				maxOutputTokens: BEDROCK_MAX_OUTPUT_TOKENS,
			}).compactAtTokens * 0.9,
		);
		expect(request.body).toMatchObject({
			model: "openai.gpt-6-astra",
			store: false,
			context_management: [
				{ type: "compaction", compact_threshold: threshold },
			],
		});
		expect(threshold).toBe(672_120);
		// The tool-call history and a compaction item replay as Responses items.
		const types = (request.body.input as { type?: string }[]).map(
			(item) => item.type ?? "message",
		);
		expect(types).toEqual([
			"message",
			"reasoning",
			"function_call",
			"function_call_output",
			"compaction",
		]);
		expect(request.body.input).toContainEqual({
			type: "compaction",
			id: "cmp_0",
			encrypted_content: "enc-cmp-0",
		});
	});

	it("is off with YTIMESY_HARBOR_BEDROCK_NATIVE_COMPACTION=off", async () => {
		const { sent, fetch } = recordingFetch();
		const { runtime } = await bedrockRuntime(fetch, {
			YTIMESY_HARBOR_BEDROCK_NATIVE_COMPACTION: "off",
		});
		expect(runtime.compact).toBeUndefined();
		await streamText({
			model: runtime.model,
			prompt: "hi",
			...runtime.requestSettings?.("Work."),
		}).consumeStream();
		expect(sent[0].body.context_management).toBeUndefined();
		expect(() =>
			harborBridgeConfig({
				...env,
				YTIMESY_HARBOR_BEDROCK_NATIVE_COMPACTION: "maybe",
			}),
		).toThrow(/must be on or off/);
	});

	it("sends V1 POST /responses/compact signed, with the Bedrock id and the tool-call history", async () => {
		const { sent, fetch } = recordingFetch();
		const { runtime } = await bedrockRuntime(fetch);
		const result = await runtime.compact?.({
			messages: toolHistory,
			instructions: "Work.",
			tools: {},
			signal: new AbortController().signal,
		});
		expect(sent).toHaveLength(1);
		const [request] = sent;
		expect(request.url).toBe(`${MANTLE}/responses/compact`);
		expect(request.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /);
		expect(request.body.model).toBe("openai.gpt-6-astra");
		expect(request.body.context_management).toBeUndefined();
		const input = request.body.input as Record<string, unknown>[];
		expect(input).toContainEqual(
			expect.objectContaining({
				type: "reasoning",
				encrypted_content: "enc-rs-1",
			}),
		);
		expect(input).toContainEqual(
			expect.objectContaining({ type: "function_call", call_id: "call_1" }),
		);
		expect(input).toContainEqual(
			expect.objectContaining({
				type: "function_call_output",
				call_id: "call_1",
			}),
		);
		expect(result?.messages).toEqual([
			{
				role: "assistant",
				content: [
					expect.objectContaining({
						type: "custom",
						kind: "openai.compaction",
					}),
				],
			},
		]);
		expect(result?.usage.inputTokens).toBe(15_278);
		expect(result?.usage.outputTokens).toBe(142);
	});

	it("counts a compaction request against the trial's guard and spend, once, and shows it in ATIF", async () => {
		const { sent, fetch } = recordingFetch();
		const events: TimedEvent[] = [];
		let latest: ApiTokenUsage | null = null;
		const config = harborBridgeConfig(env);
		const guard = trialSpendGuard({
			capUsd: 0.5,
			requestLimit: 10,
			parts: () => [{ usage: latest, billing: config.billing }],
		});
		const signal = new AbortController().signal;
		const { runtime } = await bedrockRuntime(fetch, {}, (model) =>
			guardedLanguageModel(model, guard, signal),
		);
		const onEvent = async (event: ApiAgentEvent) => {
			events.push({ at: new Date().toISOString(), event });
			if (event.type === "usage") latest = event.usage;
		};
		await runModelAgent(
			{
				userId: "harbor",
				modelId: "gpt-6-astra",
				instructions: "Work.",
				messages: [...toolHistory, { role: "user", content: "Continue" }],
				tools: {},
				signal,
				onEvent,
				onStep: async () => {},
			},
			// A small working budget so this short history compacts first.
			{ ...runtime, workingContextTokens: 2_000 },
		);
		expect(sent.map((request) => new URL(request.url).pathname)).toEqual([
			"/openai/v1/responses/compact",
			"/openai/v1/responses",
		]);
		// Both requests passed the guard: compaction counts toward the limit.
		expect(guard.requests()).toBe(2);
		expect(latest).toMatchObject({
			inputTokens: 15_278 + 2_000,
			outputTokens: 142 + 20,
		});
		// Priced at the route's (Bedrock) price, compaction included once.
		const stepOnly = usageCostUsd(
			{
				inputTokens: 2_000,
				outputTokens: 20,
				uncachedInputTokens: 2_000,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			},
			config.billing,
		) as number;
		expect(guard.spentUsd()).toBeGreaterThan(stepOnly);
		expect(guard.spentUsd()).toBeCloseTo(
			usageCostUsd(
				latest as unknown as ApiTokenUsage,
				config.billing,
			) as number,
			12,
		);
		const trajectory = atifTrajectory({
			sessionId: "trial-1",
			agent: { name: "ytimesy", version: "test" },
			modelName: "gpt-6-astra",
			billing: config.billing,
			systemPrompt: "Work.",
			instruction: "Solve the task",
			startedAt: new Date().toISOString(),
			events,
		});
		const compaction = trajectory.steps.find(
			(step) => step.extra?.kind === "compaction",
		);
		expect(compaction?.metrics).toMatchObject({
			prompt_tokens: 15_278,
			completion_tokens: 142,
		});
	});

	it("refuses a compaction request past the trial's request limit", async () => {
		const { sent, fetch } = recordingFetch();
		const config = harborBridgeConfig(env);
		const guard = trialSpendGuard({
			capUsd: 0.5,
			requestLimit: 0,
			parts: () => [],
		});
		const signal = new AbortController().signal;
		const { runtime } = await bedrockRuntime(fetch, {}, (model) =>
			guardedLanguageModel(model, guard, signal),
		);
		await expect(
			runtime.compact?.({
				messages: toolHistory,
				instructions: "Work.",
				tools: {},
				signal,
			}),
		).rejects.toBeInstanceOf(SpendCapReached);
		expect(sent).toHaveLength(0);
		expect(guard.stopReason()).toMatch(/request limit/);
		expect(config.billing.price).not.toBeNull();
	});

	it("falls back to the harness's own compaction when the compact endpoint fails", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { sent, fetch } = recordingFetch(500);
		const { runtime } = await bedrockRuntime(fetch);
		const messages = await runModelAgent(
			{
				userId: "harbor",
				modelId: "gpt-6-astra",
				instructions: "Work.",
				messages: [...toolHistory, { role: "user", content: "Continue" }],
				tools: {},
				signal: new AbortController().signal,
				onEvent: async () => {},
				onStep: async () => {},
			},
			{ ...runtime, workingContextTokens: 2_000 },
		);
		const paths = sent.map((request) => new URL(request.url).pathname);
		expect(paths[0]).toBe("/openai/v1/responses/compact");
		// Own summary (not streamed), then the step.
		expect(paths.slice(-2)).toEqual([
			"/openai/v1/responses",
			"/openai/v1/responses",
		]);
		expect(sent.at(-2)?.body.stream).toBeFalsy();
		expect(JSON.stringify(messages)).toContain(
			"Summary of earlier conversation",
		);
		expect(messages.at(-1)).toMatchObject({ role: "assistant" });
		expect(warn).toHaveBeenCalledWith(
			"Native compaction failed; using the harness's own compaction.",
			expect.objectContaining({ httpStatus: 500 }),
		);
		warn.mockRestore();
	});

	it("drops context_management for the rest of the run when Bedrock refuses it", async () => {
		const bodies: string[] = [];
		const warn = vi.fn();
		const fetch = contextManagementFallback(async (_url, init) => {
			bodies.push(String(init?.body));
			return String(init?.body).includes("context_management")
				? Response.json(
						{ error: { message: "Unknown parameter: 'context_management'." } },
						{ status: 400 },
					)
				: new Response("ok");
		}, warn);
		const body = JSON.stringify({
			model: "m",
			context_management: [{ type: "compaction", compact_threshold: 1 }],
		});
		expect(await (await fetch("https://x/responses", { body })).text()).toBe(
			"ok",
		);
		expect(await (await fetch("https://x/responses", { body })).text()).toBe(
			"ok",
		);
		expect(bodies).toEqual([body, '{"model":"m"}', '{"model":"m"}']);
		expect(warn).toHaveBeenCalledOnce();

		// Another 400 (not about compaction) is the caller's to handle.
		const other = contextManagementFallback(async () =>
			Response.json({ error: { message: "bad tool" } }, { status: 400 }),
		);
		expect((await other("https://x/responses", { body })).status).toBe(400);
	});

	it("logs the window and its source, and the compaction in use, at trial start", async () => {
		const { fetch } = recordingFetch();
		const { config, runtime } = await bedrockRuntime(fetch);
		expect(describeRuntime(runtime, config)).toEqual([
			"context window 1050000 (checked-in)",
			"native compaction openai-v2 (in-stream) + openai-v1 (compact endpoint), own-summary fallback",
		]);
		const off = await bedrockRuntime(fetch, {
			YTIMESY_HARBOR_BEDROCK_NATIVE_COMPACTION: "off",
		});
		expect(describeRuntime(off.runtime, off.config)[1]).toBe(
			"native compaction off",
		);
		expect(describeRuntime({ model: runtime.model }, config)[0]).toBe(
			"context window 128000 (fallback)",
		);
		const claude = harborBridgeConfig({
			...env,
			YTIMESY_HARBOR_MODEL: "anthropic.claude-haiku-5-5",
		});
		expect(
			describeRuntime(
				{ model: runtime.model, contextWindow: 200_000 },
				claude,
			)[0],
		).toBe("context window 200000 (stated)");
		expect(String(describeRuntime(runtime, config)[0])).toMatch(
			/^context window \d+ \(/,
		);
	});
});
