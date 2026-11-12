/**
 * Long runs, offline: a scripted provider that counts tokens the way the
 * real one does (ciphertext by the tokens it stands for) and refuses any
 * request over its window, driven far past that window. Every run must
 * finish without a compaction error, with summaries and archives in place.
 *
 * The incident these replay (TB4 jax-speedrun-gpu, 2026-10-29..31, Bedrock
 * GPT-6 Astra, 1.05M window): runs measured at 404K-611K tokens stopped in
 * the follow-up run after background jobs, on "Earlier history exceeds this
 * model's context window", because that run started without the provider's
 * measurement and a byte estimate read the encrypted reasoning as ~4x its
 * size.
 */
import {
	APICallError,
	type ModelMessage,
	simulateReadableStream,
	tool,
} from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { expect, it } from "vitest";
import { z } from "zod";
import type { ApiAgentEvent } from "#/domain/api-agent-event";
import {
	compactApiHistory,
	estimateContextTokens,
	modelContextBudget,
} from "./api-agent-context";
import { type ModelAgentRuntime, runModelAgent } from "./model-agent-loop";

type StreamPart =
	Awaited<
		ReturnType<typeof MockLanguageModelV4.prototype.doStream>
	>["stream"] extends ReadableStream<infer T>
		? T
		: never;

const TASK = "Train the model and report the validation loss";
const isUserRequest = (message: ModelMessage) =>
	message.role === "user" && message.content === TASK;

/**
 * The provider's own count, not ours: visible text at ~4 bytes per token,
 * ciphertext at the measured ~12 bytes per reasoning token.
 */
function providerTokens(prompt: unknown) {
	let opaque = 0;
	const visible = JSON.stringify(prompt, (key, value: unknown) => {
		if (
			typeof value === "string" &&
			(key === "reasoningEncryptedContent" || key === "encryptedContent")
		) {
			opaque += value.length;
			return undefined;
		}
		return value;
	});
	return Math.ceil(visible.length / 4) + Math.ceil(opaque / 12);
}

const overflow = (tokens: number, window: number) =>
	new APICallError({
		message: `This model's maximum context length is ${window} tokens. However, your messages resulted in ${tokens} tokens.`,
		url: "https://provider.test/v1/responses",
		requestBodyValues: {},
		statusCode: 400,
		responseBody: JSON.stringify({
			error: { code: "context_length_exceeded", message: "too long" },
		}),
		isRetryable: false,
	});

/**
 * A scripted Responses-style provider. Each tool step returns encrypted
 * reasoning of `reasoningBytes` and one tool call; after `steps` it
 * answers. Usage is what the provider would bill for the prompt it got.
 */
function scriptedProvider(input: {
	window: number;
	steps: number;
	reasoningBytes: number;
	label: string;
}) {
	const stats = {
		streams: 0,
		summaries: 0,
		overflows: 0,
		maxPromptTokens: 0,
		maxSummaryPromptTokens: 0,
		summaryPrompts: [] as string[],
	};
	let step = 0;
	const usage = (inputTokens: number, outputTokens: number) => ({
		inputTokens: {
			total: inputTokens,
			noCache: inputTokens,
			cacheRead: 0,
			cacheWrite: 0,
		},
		outputTokens: {
			total: outputTokens,
			text: 0,
			reasoning: outputTokens,
		},
	});
	const model = new MockLanguageModelV4({
		doGenerate: async ({ prompt }) => {
			const tokens = providerTokens(prompt);
			stats.summaries++;
			stats.maxSummaryPromptTokens = Math.max(
				stats.maxSummaryPromptTokens,
				tokens,
			);
			stats.summaryPrompts.push(JSON.stringify(prompt));
			if (tokens > input.window) {
				stats.overflows++;
				throw overflow(tokens, input.window);
			}
			return {
				content: [
					{
						type: "text",
						text: `## Requirements and constraints\n- ${TASK}\n## Decisions\n- ${input.label} summary ${stats.summaries}`,
					},
				],
				finishReason: { unified: "stop", raw: "stop" },
				usage: usage(tokens, 200),
				warnings: [],
			};
		},
		doStream: async ({ prompt }) => {
			const tokens = providerTokens(prompt);
			stats.streams++;
			stats.maxPromptTokens = Math.max(stats.maxPromptTokens, tokens);
			if (tokens > input.window) {
				stats.overflows++;
				throw overflow(tokens, input.window);
			}
			const current = ++step;
			const reasoningTokens = Math.ceil(input.reasoningBytes / 12);
			const chunks: StreamPart[] =
				current > input.steps
					? [
							{ type: "text-start", id: `t${current}` },
							{
								type: "text-delta",
								id: `t${current}`,
								delta: `${input.label} done.`,
							},
							{ type: "text-end", id: `t${current}` },
							{
								type: "finish",
								usage: usage(tokens, 10),
								finishReason: { unified: "stop", raw: "stop" },
							},
						]
					: [
							{
								type: "reasoning-start",
								id: `rs_${input.label}_${current}`,
								providerMetadata: {
									openai: {
										itemId: `rs_${input.label}_${current}`,
										reasoningEncryptedContent: "Q".repeat(input.reasoningBytes),
									},
								},
							},
							{
								type: "reasoning-delta",
								id: `rs_${input.label}_${current}`,
								delta: `Step ${current}`,
							},
							{ type: "reasoning-end", id: `rs_${input.label}_${current}` },
							{
								type: "tool-call",
								toolCallId: `call_${input.label}_${current}`,
								toolName: "run",
								input: JSON.stringify({ step: current }),
								providerMetadata: {
									openai: { itemId: `fc_${input.label}_${current}` },
								},
							},
							{
								type: "finish",
								usage: usage(tokens, reasoningTokens + 30),
								finishReason: { unified: "tool-calls", raw: "tool_calls" },
							},
						];
			return {
				stream: simulateReadableStream({
					chunks,
					initialDelayInMs: null,
					chunkDelayInMs: null,
				}),
			};
		},
	});
	return { model, stats, rewind: () => (step = 0) };
}

const runTool = (outputCharacters: number) =>
	tool({
		description: "Run one experiment",
		inputSchema: z.object({ step: z.number() }),
		execute: async ({ step }) =>
			`step ${step} log\n${"loss 3.41 ok ".repeat(Math.ceil(outputCharacters / 13))}`,
	});

function recorder() {
	const archives: ModelMessage[][] = [];
	const events: ApiAgentEvent[] = [];
	return {
		archives,
		events,
		archiveHistory: async (messages: ModelMessage[]) => {
			archives.push(messages);
			return `archive:${archives.length}`;
		},
		onEvent: async (event: ApiAgentEvent) => {
			events.push(event);
		},
		compactions: () =>
			events.filter(
				(event) => event.type === "context" && event.compacting === true,
			).length,
		lastUsage: () =>
			events
				.filter(
					(event): event is Extract<ApiAgentEvent, { type: "usage" }> =>
						event.type === "usage",
				)
				.at(-1)?.usage,
	};
}

function agentInput(
	messages: ModelMessage[],
	record: ReturnType<typeof recorder>,
	outputCharacters: number,
) {
	return {
		userId: "owner",
		modelId: "gpt-6-astra",
		instructions: "Work on the task.",
		messages,
		tools: { run: runTool(outputCharacters) },
		signal: new AbortController().signal,
		maxSteps: 500,
		onEvent: record.onEvent,
		onStep: async () => {},
		archiveHistory: record.archiveHistory,
		isUserRequest,
	};
}

const finalText = (messages: ModelMessage[]) => {
	const last = messages.at(-1);
	return last?.role === "assistant" && Array.isArray(last.content)
		? last.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
		: [];
};

/** Every tool call sent has its result, and the task is sent verbatim. */
function wellFormed(model: MockLanguageModelV4) {
	for (const call of model.doStreamCalls) {
		const sent = JSON.stringify(call.prompt);
		expect(sent).toContain(TASK);
		const calls = new Set(
			sent.match(/"type":"tool-call","toolCallId":"[^"]+/g),
		);
		const results = new Set(
			(sent.match(/"type":"tool-result","toolCallId":"[^"]+/g) ?? []).map(
				(entry) => entry.replace("tool-result", "tool-call"),
			),
		);
		expect([...calls].sort()).toEqual([...results].sort());
	}
}

it("runs 60 steps of big tool outputs and encrypted reasoning through many windows on the harness's own summary", async () => {
	const window = 60_000;
	const provider = scriptedProvider({
		window,
		steps: 60,
		reasoningBytes: 24_000,
		label: "own",
	});
	const record = recorder();
	const out = await runModelAgent(
		agentInput([{ role: "user", content: TASK }], record, 16_000),
		{
			model: provider.model,
			contextWindow: window,
			maxOutputTokens: 4_000,
			fallbackContextPolicy: "whole-turns",
		},
	);
	expect(finalText(out)).toEqual(["own done."]);
	// About 6K provider tokens a step: 60 steps are 360K, six windows.
	expect(provider.stats.overflows).toBe(0);
	expect(provider.stats.maxPromptTokens).toBeLessThan(window);
	expect(provider.stats.summaries).toBeGreaterThanOrEqual(6);
	expect(provider.stats.maxSummaryPromptTokens).toBeLessThan(window);
	// Each compaction archived the history it replaced and left a summary.
	expect(record.archives.length).toBe(provider.stats.summaries);
	const sent = JSON.stringify(provider.model.doStreamCalls.at(-1)?.prompt);
	expect(sent).toContain("Summary of earlier conversation");
	expect(sent).toMatch(/Original context archive: archive:\d+/);
	wellFormed(provider.model);
	// Every request, summaries included, is in the run's usage once.
	expect(record.lastUsage()?.requests).toBe(
		provider.stats.streams + provider.stats.summaries,
	);
});

it("replays the TB4 incident: a follow-up run after a long Astra-sized run neither stops nor compacts what the provider says fits", async () => {
	// The bridge's Bedrock Astra budget: 1.05M window, 64K output cap.
	const window = 1_050_000;
	const budget = modelContextBudget({
		contextWindow: window,
		maxOutputTokens: 64_000,
	});
	// 30 steps of 150 KB ciphertext (12.5K reasoning tokens) and 20 KB
	// output: ~525K provider tokens, as the failed trials were at 404K-611K.
	const provider = scriptedProvider({
		window,
		steps: 30,
		reasoningBytes: 150_000,
		label: "astra",
	});
	const record = recorder();
	const runtime: ModelAgentRuntime = {
		model: provider.model,
		contextWindow: window,
		maxOutputTokens: 64_000,
		fallbackContextPolicy: "whole-turns",
		compactFallback: true,
	};
	const out = await runModelAgent(
		agentInput([{ role: "user", content: TASK }], record, 20_000),
		runtime,
	);
	expect(finalText(out)).toEqual(["astra done."]);
	const measured = provider.stats.maxPromptTokens;
	expect(measured).toBeGreaterThan(400_000);
	expect(measured).toBeLessThan(budget.compactAtTokens);
	// The old estimate (all bytes / 3) read this history past the window.
	expect(Math.ceil(JSON.stringify(out).length / 3)).toBeGreaterThan(
		budget.inputLimitTokens,
	);
	expect(record.compactions()).toBe(0);
	// The follow-up run the bridge starts after background jobs exit.
	provider.rewind();
	const followUp = await runModelAgent(
		agentInput(
			[
				...out,
				{
					role: "user",
					content:
						"Background command 42084f63 finished with exit 0 after 23s.",
				},
			],
			record,
			20_000,
		),
		{
			...runtime,
			model: scriptedProvider({
				window,
				steps: 0,
				reasoningBytes: 0,
				label: "follow",
			}).model,
		},
	);
	expect(finalText(followUp)).toEqual(["follow done."]);
	expect(record.compactions()).toBe(0);
});

it("continues a reloaded multi-window history (no measurement in memory) by summarizing it in pieces", async () => {
	const window = 60_000;
	const budget = modelContextBudget({
		contextWindow: window,
		maxOutputTokens: 4_000,
	});
	// A history the provider never saw whole: 3x the input limit, as a
	// stored chat reloaded from the database, with no measurement.
	const history: ModelMessage[] = [{ role: "user", content: TASK }];
	for (let index = 0; index < 36; index++)
		history.push(
			{
				role: "assistant",
				content: [
					{
						type: "reasoning",
						text: `Step ${index}`,
						providerOptions: {
							openai: {
								itemId: `rs_old_${index}`,
								reasoningEncryptedContent: "Q".repeat(24_000),
							},
						},
					},
					{
						type: "tool-call",
						toolCallId: `call_old_${index}`,
						toolName: "run",
						input: { step: index },
					},
				],
			},
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: `call_old_${index}`,
						toolName: "run",
						output: {
							type: "text",
							value: `old step ${index} ${"loss 3.41 ok ".repeat(1_200)}`,
						},
					},
				],
			},
		);
	history.push({ role: "assistant", content: "Trained; loss 3.37." });
	expect(estimateContextTokens(history)).toBeGreaterThan(
		budget.inputLimitTokens * 3,
	);
	const provider = scriptedProvider({
		window,
		steps: 4,
		reasoningBytes: 24_000,
		label: "reloaded",
	});
	const record = recorder();
	const out = await runModelAgent(
		agentInput(
			[
				...structuredClone(history),
				{ role: "user", content: "Background job finished." },
			],
			record,
			16_000,
		),
		{
			model: provider.model,
			contextWindow: window,
			maxOutputTokens: 4_000,
			fallbackContextPolicy: "whole-turns",
		},
	);
	expect(finalText(out)).toEqual(["reloaded done."]);
	expect(provider.stats.overflows).toBe(0);
	// A rolling summary: several requests, each under the window, each after
	// the first carrying the summary so far.
	expect(provider.stats.summaries).toBeGreaterThanOrEqual(3);
	expect(provider.stats.maxSummaryPromptTokens).toBeLessThan(window);
	expect(provider.stats.summaryPrompts[1]).toContain(
		"Continuation record written by the runtime",
	);
	expect(provider.stats.summaryPrompts[1]).toContain("reloaded summary 1");
	// The full original history is archived, and the task stays verbatim.
	expect(record.archives[0]).toHaveLength(history.length + 1);
	wellFormed(provider.model);
});

it("runs far past the window on native compaction, falling back to its own pieces when the history is too large for the native request", async () => {
	const window = 60_000;
	const provider = scriptedProvider({
		window,
		steps: 50,
		reasoningBytes: 24_000,
		label: "native",
	});
	const record = recorder();
	let nativeCalls = 0;
	// A provider checkpoint (OpenAI's compaction item): ciphertext standing
	// for a few thousand tokens.
	const compact: ModelAgentRuntime["compact"] = async ({ messages }) => {
		nativeCalls++;
		const tokens = providerTokens(messages);
		if (tokens > window) throw overflow(tokens, window);
		return {
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "custom",
							kind: "openai.compaction",
							providerOptions: {
								openai: {
									itemId: `cmp_${nativeCalls}`,
									encryptedContent: "C".repeat(36_000),
								},
							},
						},
					],
				},
			],
			usage: {
				inputTokens: tokens,
				outputTokens: 3_000,
				totalTokens: tokens + 3_000,
				inputTokenDetails: {
					noCacheTokens: tokens,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
				},
				outputTokenDetails: { textTokens: 0, reasoningTokens: 3_000 },
			},
		};
	};
	const runtime: ModelAgentRuntime = {
		model: provider.model,
		contextWindow: window,
		maxOutputTokens: 4_000,
		fallbackContextPolicy: "whole-turns",
		compact,
	};
	const out = await runModelAgent(
		agentInput([{ role: "user", content: TASK }], record, 16_000),
		runtime,
	);
	expect(finalText(out)).toEqual(["native done."]);
	expect(provider.stats.overflows).toBe(0);
	expect(nativeCalls).toBeGreaterThanOrEqual(4);
	expect(record.archives.length).toBe(nativeCalls);
	const last = JSON.stringify(provider.model.doStreamCalls.at(-1)?.prompt);
	expect(last).toContain('"kind":"openai.compaction"');
	wellFormed(provider.model);
	expect(record.lastUsage()?.requests).toBe(
		provider.stats.streams + nativeCalls,
	);

	// A follow-up on that history reloaded with an old 3x-window tail
	// appended: too large for any native request. The route has no
	// compactFallback (the product's OpenAI route), yet the harness's own
	// refusal falls back to its rolling summary instead of stopping.
	const reloaded: ModelMessage[] = structuredClone(out);
	for (let index = 0; index < 12; index++)
		reloaded.push({
			role: "user",
			content: `Background command ${index} finished; output:\n${"epoch ok ".repeat(6_000)}`,
		});
	reloaded.push({ role: "user", content: "Report the result." });
	const follow = scriptedProvider({
		window,
		steps: 2,
		reasoningBytes: 24_000,
		label: "after",
	});
	const before = nativeCalls;
	const followed = await runModelAgent(agentInput(reloaded, record, 4_000), {
		...runtime,
		model: follow.model,
	});
	expect(finalText(followed)).toEqual(["after done."]);
	expect(follow.stats.overflows).toBe(0);
	expect(nativeCalls).toBe(before);
	expect(follow.stats.summaries).toBeGreaterThanOrEqual(2);
	expect(follow.stats.maxSummaryPromptTokens).toBeLessThan(window);
});

it("keeps a writer helper working across rounds and past its window inside a parent run", async () => {
	const window = 60_000;
	const parent = scriptedProvider({
		window,
		steps: 2,
		reasoningBytes: 6_000,
		label: "parent",
	});
	const writer = scriptedProvider({
		window,
		steps: 25,
		reasoningBytes: 24_000,
		label: "writer",
	});
	const parentRecord = recorder();
	const writerRecord = recorder();
	// The helper keeps its own history between rounds (the bridge's
	// roundMessages): round two continues round one's messages.
	let writerMessages: ModelMessage[] = [];
	const rounds: string[] = [];
	const writerRuntime: ModelAgentRuntime = {
		model: writer.model,
		contextWindow: window,
		maxOutputTokens: 4_000,
		fallbackContextPolicy: "whole-turns",
	};
	const startWriter = tool({
		description: "Delegate a part of the task to a writer",
		inputSchema: z.object({ step: z.number() }),
		execute: async ({ step }) => {
			writer.rewind();
			writerMessages = await runModelAgent(
				{
					...agentInput(
						[
							...writerMessages,
							{
								role: "user",
								content: step === 1 ? TASK : `Round ${step}: keep going.`,
							},
						],
						writerRecord,
						16_000,
					),
					isUserRequest: (message: ModelMessage) =>
						message.role === "user" &&
						typeof message.content === "string" &&
						(message.content === TASK || message.content.startsWith("Round")),
				},
				writerRuntime,
			);
			const report = finalText(writerMessages).join("");
			rounds.push(report);
			return report;
		},
	});
	const out = await runModelAgent(
		{
			...agentInput([{ role: "user", content: TASK }], parentRecord, 1_000),
			tools: { run: startWriter },
		},
		{
			model: parent.model,
			contextWindow: window,
			maxOutputTokens: 4_000,
			fallbackContextPolicy: "whole-turns",
		},
	);
	expect(finalText(out)).toEqual(["parent done."]);
	expect(rounds).toEqual(["writer done.", "writer done."]);
	expect(writer.stats.overflows).toBe(0);
	// 50 writer steps of ~6K tokens: several of its windows.
	expect(writer.stats.summaries).toBeGreaterThanOrEqual(4);
	expect(writerRecord.archives.length).toBe(writer.stats.summaries);
	const lastWriterRequest = JSON.stringify(
		writer.model.doStreamCalls.at(-1)?.prompt,
	);
	expect(lastWriterRequest).toContain(TASK);
	expect(lastWriterRequest).toContain("Round 2: keep going.");
	wellFormed(writer.model);
});

it("fits an active turn whose latest tool outputs alone exceed the threshold by shortening them, archived", async () => {
	const budget = { compactAtTokens: 30_000, inputLimitTokens: 40_000 };
	const messages: ModelMessage[] = [
		{ role: "user", content: TASK },
		{
			role: "assistant",
			content: [
				{
					type: "tool-call",
					toolCallId: "huge",
					toolName: "run",
					input: { step: 1 },
				},
			],
		},
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "huge",
					toolName: "run",
					output: { type: "text", value: `head ${"z".repeat(150_000)} tail` },
				},
			],
		},
	];
	const archived: ModelMessage[][] = [];
	const result = await compactApiHistory(
		messages,
		async () => "unused",
		budget,
		async (original) => {
			archived.push(original);
			return "archive:1";
		},
		"whole-turns",
		isUserRequest,
	);
	expect(result.compacted).toBe(true);
	expect(estimateContextTokens(result.messages)).toBeLessThan(
		budget.compactAtTokens,
	);
	const kept = JSON.stringify(result.messages);
	expect(kept).toContain(TASK);
	expect(kept).toContain("head ");
	expect(kept).toContain(" tail");
	expect(kept).toContain("full output is in the context archive");
	expect(kept).toContain("Original context archive: archive:1");
	expect(archived[0]).toEqual(messages);
	// Without an archive nothing is shortened: the run reports it instead.
	await expect(
		compactApiHistory(
			messages,
			async () => "unused",
			budget,
			undefined,
			"whole-turns",
		),
	).rejects.toThrow("Recent task activity exceeds");
});

it("streams its own summary on a route that refuses unstreamed requests (the ChatGPT Codex backend)", async () => {
	const window = 60_000;
	const streamed: string[] = [];
	const model = new MockLanguageModelV4({
		doGenerate: async () => {
			throw new APICallError({
				message: "Stream must be set to true",
				url: "https://chatgpt.test/backend-api/codex/responses",
				requestBodyValues: {},
				statusCode: 400,
				responseBody: '{"detail":"Stream must be set to true"}',
				isRetryable: false,
			});
		},
		doStream: async ({ prompt }) => {
			const summary = JSON.stringify(prompt).includes(
				"Write a continuation record",
			);
			streamed.push(summary ? "summary" : "step");
			const text = summary
				? "## Requirements and constraints\n- Train"
				: "Done.";
			return {
				stream: simulateReadableStream({
					chunks: [
						{ type: "text-start", id: "t" },
						{ type: "text-delta", id: "t", delta: text },
						{ type: "text-end", id: "t" },
						{
							type: "finish",
							usage: {
								inputTokens: {
									total: providerTokens(prompt),
									noCache: providerTokens(prompt),
									cacheRead: 0,
									cacheWrite: 0,
								},
								outputTokens: { total: 20, text: 20, reasoning: 0 },
							},
							finishReason: { unified: "stop", raw: "stop" },
						},
					] satisfies StreamPart[],
					initialDelayInMs: null,
					chunkDelayInMs: null,
				}),
			};
		},
	});
	const record = recorder();
	const history: ModelMessage[] = [{ role: "user", content: TASK }];
	for (let index = 0; index < 20; index++)
		history.push(
			{ role: "assistant", content: `Ran step ${index}.` },
			{ role: "user", content: `Log ${index}: ${"ok ".repeat(6_000)}` },
		);
	history.push({ role: "user", content: "Report the result." });
	const out = await runModelAgent(agentInput(history, record, 1_000), {
		model,
		contextWindow: window,
		maxOutputTokens: 4_000,
		fallbackContextPolicy: "whole-turns",
		streamOnly: true,
	});
	expect(finalText(out)).toEqual(["Done."]);
	expect(model.doGenerateCalls).toHaveLength(0);
	expect(streamed.filter((kind) => kind === "summary").length).toBeGreaterThan(
		1,
	);
	expect(record.archives).toHaveLength(1);
	expect(record.lastUsage()?.requests).toBe(streamed.length);
});

it("compacts at the first step when the user ran /compact, whatever the size; not otherwise", async () => {
	const window = 1_050_000;
	const history = (): ModelMessage[] => [
		{ role: "user", content: TASK },
		{ role: "assistant", content: [{ type: "text", text: "Earlier answer." }] },
		{ role: "user", content: "Second request." },
		{ role: "assistant", content: [{ type: "text", text: "Second answer." }] },
		{ role: "user", content: "Reply briefly." },
	];
	const run = async (compactNow: boolean) => {
		const provider = scriptedProvider({
			window,
			steps: 0,
			reasoningBytes: 100,
			label: "quiet",
		});
		const out = await runModelAgent(
			{
				...agentInput(history(), recorder(), 100),
				...(compactNow ? { compactNow: true } : {}),
			},
			{
				model: provider.model,
				contextWindow: window,
				maxOutputTokens: 64_000,
				fallbackContextPolicy: "whole-turns",
				compactFallback: true,
			},
		);
		return { provider, out };
	};
	const plain = await run(false);
	expect(plain.provider.stats.summaries).toBe(0);
	const manual = await run(true);
	expect(manual.provider.stats.summaries).toBeGreaterThanOrEqual(1);
	expect(finalText(manual.out)).toEqual(["quiet done."]);
});
