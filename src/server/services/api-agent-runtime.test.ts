import { APICallError, simulateReadableStream, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { Effect } from "effect";
import { beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { SafeApiModelFailure } from "#/domain/api-turn-failure";
import { nativeModelCompactor } from "../adapters/model-compaction";
import {
	type ApiAgentEvent,
	runApiAgent,
	runModelAgent,
} from "./api-agent-runtime";
import { endsWithCommentary, runModelAgentStep } from "./model-agent-loop";
import { verifyApiModel } from "./model-connections";

const mocks = vi.hoisted(() => ({
	load: vi.fn(),
	model: vi.fn(),
	close: vi.fn(),
	claim: vi.fn(),
	verified: vi.fn(),
}));
vi.mock("#/server/adapters/model-connections", () => ({
	loadModelConnection: mocks.load,
	claimModelProbe: mocks.claim,
	markModelVerified: mocks.verified,
}));
vi.mock("#/server/adapters/api-model", () => ({
	connectedLanguageModel: mocks.model,
}));
// Gateway routes consult the public catalog; tests must never reach the network.
vi.mock("#/server/adapters/browse-models", () => ({
	browseModels: async () => [
		{
			id: "openai/gpt-6.1-sol",
			label: "OpenAI: GPT-6.1 Sol",
			author: "openai",
			created: 1,
			contextWindow: 272_000,
		},
	],
}));
vi.mock("#/server/adapters/model-endpoint", () => ({
	modelEndpointTransport: () => ({ fetch: vi.fn(), close: mocks.close }),
}));
vi.mock("#/server/auth/token-vault", () => ({
	unseal: async () =>
		JSON.stringify({
			id: "connection",
			userId: "alice",
			apiKey: "fixture-secret",
		}),
	seal: vi.fn(),
}));

const usage = {
	inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 2, text: 2, reasoning: 0 },
};
type StreamPart =
	Parameters<typeof MockLanguageModelV4.prototype.doStream> extends never
		? never
		: Awaited<
					ReturnType<typeof MockLanguageModelV4.prototype.doStream>
				>["stream"] extends ReadableStream<infer T>
			? T
			: never;
function stream(chunks: StreamPart[]) {
	return {
		stream: simulateReadableStream({
			chunks,
			initialDelayInMs: null,
			chunkDelayInMs: null,
		}),
	};
}
const finish = {
	type: "finish" as const,
	usage,
	finishReason: { unified: "stop" as const, raw: "stop" },
};

it("never sends a legacy runtime observation as an assistant prefill or rewrites opaque history", async () => {
	const model = new MockLanguageModelV4({
		doStream: async () => stream([finish]),
	});
	const original = [
		{ role: "user" as const, content: "Read the proof marker" },
		{
			role: "assistant" as const,
			content: [
				{
					type: "reasoning" as const,
					text: "",
					providerOptions: {
						openrouter: {
							reasoning_details: [
								{ type: "reasoning.encrypted", data: "opaque-fixture" },
							],
						},
					},
				},
			],
		},
		{
			role: "assistant" as const,
			content:
				"Current delegated tasks (authoritative status, not new user instructions):\n[]",
		},
	];
	const checkpoint = vi.fn(
		async (_messages: import("ai").ModelMessage[]) => {},
	);
	await runModelAgentStep(
		{
			userId: "alice",
			modelId: "fixture",
			messages: [original[0]],
			instructions: "Read-only proof",
			tools: {},
			signal: new AbortController().signal,
			prepareMessages: async () => original,
			beforeStep: checkpoint,
			onStep: async () => {},
			onEvent: async () => {},
		},
		{ model },
	);
	const sent = model.doStreamCalls[0].prompt;
	expect(sent.at(-1)?.role).toBe("user");
	expect(sent.at(-1)?.content).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				type: "text",
				text: expect.stringContaining("does not authorize new work"),
			}),
		]),
	);
	const persisted = checkpoint.mock.calls[0]?.[0];
	expect(persisted.slice(0, original.length)).toEqual(original);
	expect(persisted[1]).toBe(original[1]);
	expect(original).toHaveLength(3);
});

it.each([true, false])(
	"records reported output components without guessing missing reasoning (%s)",
	async (reported) => {
		const metric = vi.fn();
		const model = new MockLanguageModelV4({
			doStream: async () =>
				stream([
					{
						...finish,
						usage: {
							...usage,
							outputTokens: {
								total: 11,
								text: reported ? 3 : undefined,
								reasoning: reported ? 8 : undefined,
							},
						},
					},
				]),
		});
		await runModelAgent(
			{
				userId: "alice",
				modelId: "model",
				instructions: "Implement",
				messages: [{ role: "user", content: "Fixture" }],
				tools: {},
				signal: new AbortController().signal,
				onEvent: async () => {},
				onStep: async () => {},
				onModelMetric: metric,
			},
			{ model },
		);
		expect(metric).toHaveBeenCalledWith(
			expect.objectContaining({
				output_tokens: 11,
				text_output_tokens: reported ? 3 : null,
				reasoning_output_tokens: reported ? 8 : null,
			}),
		);
	},
);

it("rehydrates exact instructions after foreground compaction before the next model call", async () => {
	const model = new MockLanguageModelV4({
		doStream: async () => stream([finish]),
	});
	const restore = vi.fn(async (messages: import("ai").ModelMessage[]) => [
		...messages,
		{
			role: "assistant" as const,
			content: "Exact repository requirement: preserve wire format",
		},
	]);
	const afterTools = vi.fn(
		async (messages: import("ai").ModelMessage[]) => messages,
	);
	await runModelAgent(
		{
			userId: "alice",
			modelId: "model",
			instructions: "Implement",
			messages: [
				{ role: "user", content: "Earlier task" },
				{ role: "assistant", content: "e".repeat(30000) },
				{ role: "user", content: "Continue" },
			],
			tools: {},
			signal: new AbortController().signal,
			onEvent: async () => {},
			onStep: async () => {},
			archiveHistory: async () => "archive:fixture",
			restoreInstructions: restore,
			afterTools,
		},
		{
			model,
			contextWindow: 16000,
			workingContextTokens: 4000,
			compact: async () => ({
				messages: [{ role: "assistant", content: "Compacted earlier work" }],
				usage: {
					inputTokens: 1,
					outputTokens: 1,
					totalTokens: 2,
					inputTokenDetails: {
						noCacheTokens: 1,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
					},
					outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
				},
			}),
		},
	);
	expect(restore).toHaveBeenCalledOnce();
	expect(JSON.stringify(model.doStreamCalls[0])).toContain(
		"Exact repository requirement",
	);
	expect(afterTools).toHaveBeenCalledOnce();
});

it("projects earlier command output into recoverable receipts only on unbound routes", async () => {
	for (const policy of ["whole-turns", "bound-prefix"] as const) {
		const model = new MockLanguageModelV4({
			doStream: async () => stream([finish]),
		});
		const body = "retained command log ".repeat(350);
		const messages = [
			{ role: "user" as const, content: "Earlier task" },
			{
				role: "assistant" as const,
				content: [
					{
						type: "tool-call" as const,
						toolName: "bash",
						toolCallId: "historical",
						input: { command: "test" },
					},
				],
			},
			{
				role: "tool" as const,
				content: [
					{
						type: "tool-result" as const,
						toolName: "bash",
						toolCallId: "historical",
						output: {
							type: "json" as const,
							value: {
								reference: "37ba9eb0-031e-4b82-9296-e4ce22f9ee7e",
								exitCode: 1,
								stopped: null,
								stdout: body,
								stderr: "failed",
							},
						},
					},
				],
			},
			{ role: "assistant" as const, content: "Test failed; repair needed." },
			{ role: "user" as const, content: "Continue" },
		];
		const archive = vi.fn(async () => "archive:command");
		await runModelAgent(
			{
				userId: "alice",
				modelId: "model",
				instructions: "Repair",
				messages,
				tools: {
					bash: tool({
						inputSchema: z.object({ command: z.string() }),
						execute: async () => ({}),
					}),
				},
				knownTools: ["bash"],
				signal: new AbortController().signal,
				archiveHistory: archive,
				onEvent: async () => {},
				onStep: async () => {},
			},
			{ model, archiveConsumedGuidance: true, fallbackContextPolicy: policy },
		);
		const request = JSON.stringify(model.doStreamCalls[0]);
		if (policy === "whole-turns") {
			expect(archive).toHaveBeenCalledExactlyOnceWith(messages);
			expect(request).toContain("archivedOutput");
			expect(request).not.toContain(body);
		} else {
			expect(archive).not.toHaveBeenCalled();
			expect(request).toContain(body);
		}
		expect(request).toContain("failed");
		expect(request).toContain("historical");
	}
});

it("adopts a background native checkpoint after the tool step without losing the live call/result pair", async () => {
	let announceCompaction = () => {};
	let announceTool = () => {};
	const compactionStarted = new Promise<void>((resolve) => {
		announceCompaction = resolve;
	});
	const toolStarted = new Promise<void>((resolve) => {
		announceTool = resolve;
	});
	const compact = vi.fn(async () => {
		announceCompaction();
		await toolStarted;
		return {
			messages: [{ role: "assistant" as const, content: "earlier checkpoint" }],
			usage: {
				inputTokens: 20,
				outputTokens: 5,
				totalTokens: 25,
				inputTokenDetails: {
					noCacheTokens: 20,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
				},
				outputTokenDetails: { textTokens: 5, reasoningTokens: 0 },
			},
		};
	});
	const model = new MockLanguageModelV4({
		doStream: async () =>
			stream([
				{
					type: "tool-call",
					toolCallId: "read-current",
					toolName: "inspect",
					input: "{}",
				},
				{
					...finish,
					finishReason: { unified: "tool-calls", raw: "tool_calls" },
				},
			]),
	});
	const archive = vi.fn(async () => "archive:fixture");
	const result = await runModelAgentStep(
		{
			userId: "alice",
			modelId: "model",
			instructions: "Inspect",
			knownTools: ["inspect"],
			messages: [
				{ role: "user", content: "previous request" },
				{ role: "assistant", content: "e".repeat(10500) },
				{ role: "user", content: "Inspect live task" },
			],
			tools: {
				inspect: tool({
					inputSchema: z.object({}),
					execute: async () => {
						announceTool();
						await compactionStarted;
						return "current evidence";
					},
				}),
			},
			signal: new AbortController().signal,
			archiveHistory: archive,
			onEvent: async () => {},
			onStep: async () => {},
		},
		{
			model,
			compact,
			contextWindow: 16000,
			workingContextTokens: 4000,
			backgroundCompaction: true,
		},
	);
	expect(result.messages.at(-1)).toMatchObject({
		role: "tool",
		content: [{ output: { type: "text", value: "current evidence" } }],
	});
	expect(compact).toHaveBeenCalledTimes(1);
	expect(archive).toHaveBeenCalledTimes(1);
	expect(result.outcome).toBe("continue");
	expect(result.messages[0]).toEqual({
		role: "assistant",
		content: "earlier checkpoint",
	});
	expect(result.messages[1]).toEqual({
		role: "user",
		content: "Inspect live task",
	});
	expect(JSON.stringify(result.messages)).toContain("read-current");
	expect(result.messages.at(-1)?.role).toBe("tool");
	expect(JSON.stringify(result.messages)).not.toContain("e".repeat(100));
});

it("budgets deferred schemas only after discovery, while preserving the hard input limit", async () => {
	const optional = tool({
		description: "Optional browser capability ".repeat(4000),
		inputSchema: z.object({ url: z.string() }),
		execute: async () => ({}),
	});
	for (const knownTools of [[], ["browser_screenshot"]]) {
		const model = new MockLanguageModelV4({
			doStream: async () => stream([finish]),
		});
		const pending = runModelAgent(
			{
				userId: "alice",
				modelId: "model",
				instructions: "Keep every required check",
				messages: [{ role: "user", content: "Inspect the task" }],
				tools: { browser_screenshot: optional },
				knownTools,
				signal: new AbortController().signal,
				onStep: async () => {},
				onEvent: async () => {},
			},
			{ model, contextWindow: 12_000 },
		);
		if (knownTools.length) {
			await expect(pending).rejects.toBeInstanceOf(SafeApiModelFailure);
			expect(model.doStreamCalls).toHaveLength(0);
		} else {
			await pending;
			expect(model.doStreamCalls).toHaveLength(1);
			expect(JSON.stringify(model.doStreamCalls[0].tools)).not.toContain(
				"Optional browser capability",
			);
		}
	}
});

it("still rejects a native checkpoint exceeding the hard input limit without replacing original history", async () => {
	const model = new MockLanguageModelV4();
	const checkpoint = vi.fn();
	const compact = vi.fn(async () => ({
		messages: [
			{
				role: "assistant" as const,
				content: [
					{
						type: "custom" as const,
						kind: "openai.compaction" as const,
						providerOptions: {
							openai: {
								itemId: "oversized",
								encryptedContent: "e".repeat(180_000),
							},
						},
					},
				],
			},
		],
		usage: {
			inputTokens: 12_000,
			outputTokens: 10,
			totalTokens: 12_010,
			inputTokenDetails: {
				noCacheTokens: 12_000,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			},
			outputTokenDetails: { textTokens: 0, reasoningTokens: 10 },
		},
	}));
	await expect(
		runModelAgent(
			{
				userId: "alice",
				modelId: "model",
				instructions: "Keep the task",
				messages: [{ role: "user", content: "Continue the task" }],
				previousContext: { tokens: 12_000, modelContextWindow: 48_000 },
				tools: {},
				signal: new AbortController().signal,
				onStep: checkpoint,
				onEvent: async () => {},
			},
			{ model, contextWindow: 48_000, workingContextTokens: 4_000, compact },
		),
	).rejects.toThrow();
	expect(compact).toHaveBeenCalledOnce();
	expect(model.doStreamCalls).toHaveLength(0);
	expect(checkpoint).not.toHaveBeenCalled();
});

it.each([
	{
		historyLength: 95_000,
		checkpointSuffix: 0,
		previousContext: undefined,
		workingContextTokens: undefined,
	},
	{
		historyLength: 9_000,
		previousContext: { tokens: 32_000, modelContextWindow: 48_000 },
		checkpointSuffix: 0,
		workingContextTokens: undefined,
	},
	{
		historyLength: 9_000,
		previousContext: { tokens: 12_000, modelContextWindow: 48_000 },
		checkpointSuffix: 0,
		workingContextTokens: 8_000,
	},
	{
		historyLength: 9_000,
		previousContext: { tokens: 12_000, modelContextWindow: 48_000 },
		checkpointSuffix: 24_000,
		workingContextTokens: 4_000,
	},
])(
	"uses native compaction with estimated or measured context ($historyLength), checkpoints opaque state and never streams it as a response",
	async ({
		historyLength,
		previousContext,
		workingContextTokens,
		checkpointSuffix,
	}) => {
		const checkpoint = vi.fn();
		const events: ApiAgentEvent[] = [];
		let calls = 0;
		const model = new MockLanguageModelV4({
			doStream: async () =>
				stream(
					++calls === 1
						? [
								{
									type: "custom",
									kind: "openai.compaction",
									providerMetadata: {
										openai: {
											type: "compaction",
											itemId: "cmp-fixture",
											encryptedContent: `opaque-fixture${"e".repeat(checkpointSuffix)}`,
										},
									},
								},
								finish,
							]
						: [
								{ type: "text-start", id: "reply" },
								{ type: "text-delta", id: "reply", delta: "Done" },
								{ type: "text-end", id: "reply" },
								finish,
							],
				),
		});
		const requestSettings = (instructions: string) => ({
			providerOptions: { openai: { instructions, store: false } },
		});
		const input = {
			userId: "alice",
			modelId: "model",
			instructions: "Project knowledge stays here",
			previousContext,
			tools: {},
			messages: [
				{
					role: "user" as const,
					content: `Old request ${"x".repeat(historyLength)}`,
				},
				{ role: "assistant" as const, content: "Earlier findings" },
				{ role: "user" as const, content: "Complete the pending task" },
			],
			signal: new AbortController().signal,
			onStep: checkpoint,
			onEvent: async (event: ApiAgentEvent) => {
				events.push(event);
			},
		};
		const result = await runModelAgent(input, {
			model,
			contextWindow: 48_000,
			workingContextTokens,
			requestSettings,
			compact: nativeModelCompactor(model, "openai", requestSettings),
		});
		expect(model.doGenerateCalls).toHaveLength(0);
		expect(model.doStreamCalls).toHaveLength(2);
		expect(model.doStreamCalls[0].providerOptions?.openai).toMatchObject({
			compactionTrigger: true,
		});
		expect(JSON.stringify(model.doStreamCalls[1])).toContain("opaque-fixture");
		expect(JSON.stringify(checkpoint.mock.calls[0])).not.toContain(
			"x".repeat(1000),
		);
		expect(JSON.stringify(result)).toContain("Complete the pending task");
		expect(JSON.stringify(events)).not.toContain("opaque-fixture");
		expect(events.filter((event) => event.type === "context")).toMatchObject([
			{ compacting: true },
			{ compacting: false },
			{
				compacting: false,
				context: { last: { totalTokens: 5 }, modelContextWindow: 48_000 },
			},
		]);
		expect(events.find((event) => event.type === "finish")).toMatchObject({
			inputTokens: 6,
			outputTokens: 4,
		});
	},
);

it("durable one-step execution checkpoints a tool result without starting a second inference", async () => {
	const inference = vi.fn(async () =>
		stream([
			{ type: "stream-start", warnings: [] },
			{
				type: "tool-call",
				toolCallId: "inspect-1",
				toolName: "inspect",
				input: "{}",
			},
			{
				...finish,
				finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
			},
		]),
	);
	const events: ApiAgentEvent[] = [];
	const checkpoint = vi.fn();
	const result = await runModelAgentStep(
		{
			userId: "alice",
			modelId: "model",
			messages: [{ role: "user", content: "Inspect" }],
			instructions: "Inspect",
			knownTools: ["inspect"],
			tools: {
				inspect: tool({
					inputSchema: z.object({}),
					execute: async () => "verified result",
				}),
			},
			signal: new AbortController().signal,
			onStep: checkpoint,
			onEvent: async (event) => {
				events.push(event);
			},
		},
		{ model: new MockLanguageModelV4({ doStream: inference }) },
	);
	expect(inference).toHaveBeenCalledTimes(1);
	expect(result.outcome).toBe("continue");
	expect(result.messages.at(-1)?.role).toBe("tool");
	expect(checkpoint).toHaveBeenCalledTimes(1);
	expect(events.some((event) => event.type === "finish")).toBe(false);
	expect(events.find((event) => event.type === "tool-result")).toMatchObject({
		output: "verified result",
	});
});

it("retains full tool events while checkpointing the SDK's compact model view", async () => {
	const evidence = {
		passed: true,
		reference: "receipt",
		fullEvidence: "retained-full-proof",
	};
	const events: ApiAgentEvent[] = [];
	const result = await runModelAgentStep(
		{
			userId: "alice",
			modelId: "model",
			instructions: "Inspect",
			messages: [{ role: "user", content: "Inspect" }],
			knownTools: ["inspect"],
			tools: {
				inspect: tool({
					inputSchema: z.object({}),
					execute: async () => evidence,
					toModelOutput: () => ({
						type: "json",
						value: { passed: true, reference: "receipt" },
					}),
				}),
			},
			signal: new AbortController().signal,
			onStep: async () => {},
			onEvent: async (event) => {
				events.push(event);
			},
		},
		{
			model: new MockLanguageModelV4({
				doStream: async () =>
					stream([
						{
							type: "tool-call",
							toolCallId: "inspect-1",
							toolName: "inspect",
							input: "{}",
						},
						{
							...finish,
							finishReason: { unified: "tool-calls", raw: "tool_calls" },
						},
					]),
			}),
		},
	);
	expect(events.find((event) => event.type === "tool-result")).toMatchObject({
		output: evidence,
	});
	expect(JSON.stringify(result.messages.at(-1))).toContain("receipt");
	expect(JSON.stringify(result.messages.at(-1))).not.toContain(
		"retained-full-proof",
	);
});

it("does not compact provider-measured small context merely because opaque state has a large wire encoding", async () => {
	const compact = vi.fn();
	const model = new MockLanguageModelV4({ doStream: stream([finish]) });
	const messages = [
		{ role: "user" as const, content: "Original request" },
		{
			role: "assistant" as const,
			content: [
				{
					type: "reasoning" as const,
					text: "",
					providerOptions: {
						openai: { encryptedContent: "opaque".repeat(30000) },
					},
				},
			],
		},
		{ role: "user" as const, content: "Continue" },
	];
	await runModelAgent(
		{
			userId: "alice",
			modelId: "model",
			instructions: "Test",
			messages,
			previousContext: { tokens: 2000, modelContextWindow: 16000 },
			tools: {},
			signal: new AbortController().signal,
			onStep: async () => {},
			onEvent: async () => {},
		},
		{ model, contextWindow: 16000, workingContextTokens: 4000, compact },
	);
	expect(compact).not.toHaveBeenCalled();
	expect(model.doStreamCalls).toHaveLength(1);
	expect(JSON.stringify(model.doStreamCalls[0])).toContain(
		"opaque".repeat(30000),
	);
});
beforeEach(() => {
	vi.clearAllMocks();
	mocks.load.mockResolvedValue({
		id: "connection",
		provider: "compatible",
		revision: "revision",
		baseUrl: "https://api.openai.com/v1",
		sealedCredential: "sealed",
		models: [{ id: "model", toolStreamingVerified: true }],
	});
	mocks.claim.mockResolvedValue(true);
	mocks.verified.mockResolvedValue(true);
});

function run(events: ApiAgentEvent[], tools = {}) {
	return runApiAgent({
		userId: "alice",
		connectionId: "connection",
		modelId: "model",
		messages: [{ role: "user", content: "Test" }],
		instructions: "Test instructions",
		tools,
		signal: new AbortController().signal,
		onEvent: async (event) => {
			events.push(event);
		},
		onStep: async () => {},
	});
}

it("reports a bounded preparation stage and closes transport when adapter construction fails", async () => {
	mocks.model.mockImplementationOnce(() => {
		throw new TypeError("fixture-sensitive-request");
	});
	await expect(run([])).rejects.toThrow(
		"API model preparation failed during model. No inference was started.",
	);
	expect(mocks.close).toHaveBeenCalledOnce();
});

it.each(["openai", "openrouter"] as const)(
	"preserves earlier cached tool output on the %s route",
	async (provider) => {
		const modelId =
			provider === "openai" ? "gpt-6.1-sol" : "openai/gpt-6.1-sol";
		mocks.load.mockResolvedValue({
			id: "connection",
			provider,
			revision: `cache-prefix-${provider}`,
			sealedCredential: "sealed",
			baseUrl:
				provider === "openai"
					? "https://api.openai.com/v1"
					: "https://openrouter.ai/api/v1",
			models: [
				{ id: modelId, toolStreamingVerified: true, contextWindow: 272_000 },
			],
		});
		const model = new MockLanguageModelV4({
			doStream: async () => stream([finish]),
		});
		mocks.model.mockReturnValue(model);
		const body = "complete earlier command evidence ".repeat(600);
		const archive = vi.fn(async () => "archive:fixture");
		await runApiAgent({
			userId: "alice",
			connectionId: "connection",
			modelId,
			instructions: "Continue safely",
			tools: {},
			messages: [
				{ role: "user", content: "Investigate" },
				{
					role: "assistant",
					content: [
						{
							type: "tool-call",
							toolCallId: "earlier-command",
							toolName: "bash",
							input: { command: "test" },
						},
					],
				},
				{
					role: "tool",
					content: [
						{
							type: "tool-result",
							toolCallId: "earlier-command",
							toolName: "bash",
							output: {
								type: "json",
								value: {
									reference: "37ba9eb0-031e-4b82-9296-e4ce22f9ee7e",
									exitCode: 1,
									stopped: null,
									stdout: body,
									stderr: "failed",
								},
							},
						},
					],
				},
				{ role: "assistant", content: "Observed the failure" },
				{ role: "user", content: "Continue" },
			],
			signal: new AbortController().signal,
			archiveHistory: archive,
			onEvent: async () => {},
			onStep: async () => {},
		});
		expect(archive).not.toHaveBeenCalled();
		expect(JSON.stringify(model.doStreamCalls[0].prompt)).toContain(body);
	},
);

it("does not report a tool-step-limit stop as successful completion", async () => {
	mocks.model.mockReturnValue(
		new MockLanguageModelV4({
			doStream: async () =>
				stream([
					{ type: "stream-start", warnings: [] },
					{
						type: "tool-call",
						toolCallId: "call",
						toolName: "inspect",
						input: "{}",
					},
					{
						...finish,
						finishReason: { unified: "tool-calls", raw: "tool_calls" },
					},
				]),
		}),
	);
	const events: ApiAgentEvent[] = [];
	await expect(
		runApiAgent({
			userId: "alice",
			connectionId: "connection",
			modelId: "model",
			messages: [{ role: "user", content: "Inspect" }],
			instructions: "Inspect",
			tools: {
				inspect: tool({
					inputSchema: z.object({}),
					execute: async () => "result",
				}),
			},
			signal: new AbortController().signal,
			maxSteps: 1,
			onEvent: async (event) => {
				events.push(event);
			},
			onStep: async () => {},
		}),
	).rejects.toThrow("tool-step limit");
	expect(events.some((event) => event.type === "finish")).toBe(false);
});

it("streams text and supplied reasoning, executes a tool, then continues to the answer", async () => {
	const execute = vi.fn(async ({ path }: { path: string }) => `read ${path}`);
	const model = new MockLanguageModelV4({
		doStream: [
			stream([
				{ type: "stream-start", warnings: [] },
				{ type: "reasoning-start", id: "r" },
				{ type: "reasoning-delta", id: "r", delta: "Inspect file" },
				{ type: "reasoning-end", id: "r" },
				{
					type: "tool-call",
					toolCallId: "call",
					toolName: "read_file",
					input: '{"path":"README.md"}',
				},
				{
					...finish,
					finishReason: { unified: "tool-calls", raw: "tool_calls" },
				},
			]),
			stream([
				{ type: "stream-start", warnings: [] },
				{ type: "text-start", id: "a" },
				{ type: "text-delta", id: "a", delta: "Done" },
				{ type: "text-end", id: "a" },
				finish,
			]),
		],
	});
	mocks.model.mockReturnValue(model);
	const events: ApiAgentEvent[] = [];
	const messages = await run(events, {
		read_file: tool({ inputSchema: z.object({ path: z.string() }), execute }),
	});
	expect(execute).toHaveBeenCalledOnce();
	expect(model.doStreamCalls).toHaveLength(2);
	expect(events.filter((event) => event.type === "usage")).toEqual([
		{
			type: "usage",
			usage: {
				inputTokens: 3,
				outputTokens: 2,
				uncachedInputTokens: 3,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			},
		},
		{
			type: "usage",
			usage: {
				inputTokens: 6,
				outputTokens: 4,
				uncachedInputTokens: 6,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			},
		},
	]);
	expect(events).toContainEqual({ type: "text-delta", id: "a", text: "Done" });
	expect(events).toContainEqual({
		type: "reasoning-delta",
		id: "r",
		text: "Inspect file",
	});
	expect(events).toContainEqual({
		type: "tool-result",
		id: "call",
		name: "read_file",
		output: "read README.md",
	});
	expect(messages.some((message) => message.role === "tool")).toBe(true);
	expect(mocks.close).toHaveBeenCalledOnce();
});

it("retains safe-point peer input across later model steps without restarting the run", async () => {
	const toolStep = (id: string) =>
		stream([
			{ type: "stream-start", warnings: [] },
			{ type: "tool-call", toolCallId: id, toolName: "inspect", input: "{}" },
			{ ...finish, finishReason: { unified: "tool-calls", raw: "tool_calls" } },
		]);
	const model = new MockLanguageModelV4({
		doStream: [toolStep("one"), toolStep("two"), stream([finish])],
	});
	mocks.model.mockReturnValue(model);
	let step = 0;
	const history = await runApiAgent({
		userId: "alice",
		connectionId: "connection",
		modelId: "model",
		messages: [{ role: "user", content: "Original task" }],
		instructions: "Test",
		tools: {
			inspect: tool({
				inputSchema: z.object({}),
				execute: async () => "checked",
			}),
		},
		signal: new AbortController().signal,
		onEvent: async () => {},
		onStep: async () => {},
		prepareMessages: async (messages) =>
			++step === 2
				? [...messages, { role: "user", content: "Peer owns schema.ts" }]
				: messages,
	});
	expect(model.doStreamCalls).toHaveLength(3);
	expect(JSON.stringify(model.doStreamCalls[0])).not.toContain(
		"Peer owns schema.ts",
	);
	expect(JSON.stringify(model.doStreamCalls[1])).toContain(
		"Peer owns schema.ts",
	);
	expect(JSON.stringify(model.doStreamCalls[2])).toContain(
		"Peer owns schema.ts",
	);
	expect(
		history.filter(
			(item) => item.role === "user" && item.content === "Peer owns schema.ts",
		),
	).toHaveLength(1);
});

it("summarizes older history before a model step and checkpoints the compacted messages", async () => {
	const events: ApiAgentEvent[] = [];
	const model = new MockLanguageModelV4({
		doGenerate: async () => ({
			content: [
				{
					type: "text" as const,
					text: "Earlier task was inspected; no edits were made.",
				},
			],
			finishReason: { unified: "stop" as const, raw: "stop" },
			usage,
			warnings: [],
		}),
		doStream: stream([
			{ type: "text-start", id: "a" },
			{ type: "text-delta", id: "a", delta: "Ready" },
			{ type: "text-end", id: "a" },
			finish,
		]),
	});
	mocks.model.mockReturnValue(model);
	const checkpoints: unknown[][] = [];
	await runApiAgent({
		userId: "alice",
		connectionId: "connection",
		modelId: "model",
		messages: [
			{ role: "user", content: `old request ${"x".repeat(95_000)}` },
			{ role: "assistant", content: "Earlier work" },
			{ role: "user", content: "Continue the task" },
		],
		instructions:
			"Test instructions. Shared project knowledge: branch picker already implemented in src/branches.ts",
		tools: {},
		signal: new AbortController().signal,
		onEvent: async (event) => {
			events.push(event);
		},
		onStep: async (messages) => {
			checkpoints.push(messages);
		},
	});
	expect(model.doGenerateCalls).toHaveLength(1);
	expect(model.doStreamCalls).toHaveLength(1);
	expect(JSON.stringify(model.doStreamCalls[0])).toContain(
		"branch picker already implemented in src/branches.ts",
	);
	expect(JSON.stringify(model.doStreamCalls[0])).not.toContain(
		"x".repeat(1_000),
	);
	expect(JSON.stringify(checkpoints[0])).toContain(
		"Earlier task was inspected",
	);
	expect(events.filter((event) => event.type === "usage")).toMatchObject([
		{ usage: { inputTokens: 3, outputTokens: 2 } },
		{ usage: { inputTokens: 6, outputTokens: 4 } },
	]);
	expect(events.find((event) => event.type === "finish")).toMatchObject({
		inputTokens: 6,
		outputTokens: 4,
	});
});

it("does not begin compaction inference after the run deadline", async () => {
	const deadline = new AbortController();
	const timeout = vi
		.spyOn(AbortSignal, "timeout")
		.mockReturnValue(deadline.signal);
	const model = new MockLanguageModelV4({ doStream: stream([finish]) });
	try {
		await expect(
			runModelAgent(
				{
					userId: "alice",
					modelId: "model",
					instructions: "Test",
					tools: {},
					messages: [
						{ role: "user", content: "x".repeat(95000) },
						{ role: "assistant", content: "Earlier work" },
						{ role: "user", content: "Continue" },
					],
					signal: new AbortController().signal,
					onEvent: async () => {},
					onStep: async () => {},
					beforeCompaction: async () => {
						deadline.abort(new Error("Evaluation deadline"));
					},
				},
				{ model },
			),
		).rejects.toThrow();
		expect(model.doGenerateCalls).toHaveLength(0);
	} finally {
		timeout.mockRestore();
	}
});

it("runs a listed model without a separate verification request", async () => {
	mocks.load.mockResolvedValue({
		id: "connection",
		provider: "compatible",
		revision: "revision",
		baseUrl: "https://api.openai.com/v1",
		sealedCredential: "sealed",
		models: [{ id: "model", toolStreamingVerified: false }],
	});
	mocks.model.mockReturnValue(
		new MockLanguageModelV4({
			doStream: stream([
				{ type: "text-start", id: "a" },
				{ type: "text-delta", id: "a", delta: "Ready" },
				{ type: "text-end", id: "a" },
				finish,
			]),
		}),
	);
	const events: ApiAgentEvent[] = [];
	await run(events);
	expect(events).toContainEqual({ type: "text-delta", id: "a", text: "Ready" });
	expect(mocks.claim).not.toHaveBeenCalled();
});

it("rejects unavailable connections before any provider request", async () => {
	mocks.load.mockResolvedValue(null);
	await expect(run([])).rejects.toThrow("no longer available");
	expect(mocks.model).not.toHaveBeenCalled();
});

it("rejects a changed queued connection before contacting the provider", async () => {
	await expect(
		runApiAgent({
			userId: "alice",
			connectionId: "connection",
			connectionRevision: "old-revision",
			modelId: "model",
			messages: [],
			instructions: "Diagnose",
			tools: {},
			signal: new AbortController().signal,
			onEvent: async () => {},
			onStep: async () => {},
		}),
	).rejects.toThrow("connection changed");
	expect(mocks.model).not.toHaveBeenCalled();
});

it("does not log or retry unclassified failures and never falls back", async () => {
	const log = vi.spyOn(console, "error").mockImplementation(() => {});
	const model = new MockLanguageModelV4({
		doStream: async () => {
			throw new Error("fixture-secret");
		},
	});
	mocks.model.mockReturnValue(model);
	try {
		await expect(run([])).rejects.toThrow("No fallback was used");
		expect(model.doStreamCalls).toHaveLength(1);
		expect(log).not.toHaveBeenCalled();
		expect(mocks.close).toHaveBeenCalledOnce();
	} finally {
		log.mockRestore();
	}
});

it("retries one retryable request-start failure without replaying completed tools", async () => {
	let calls = 0;
	const execute = vi.fn(async () => "checked");
	const model = new MockLanguageModelV4({
		doStream: async () => {
			if (++calls === 1)
				throw new APICallError({
					message: "private temporary error",
					url: "https://example.com",
					requestBodyValues: {},
					statusCode: 503,
				});
			return stream(
				calls === 2
					? [
							{
								type: "tool-call",
								toolCallId: "once",
								toolName: "inspect",
								input: "{}",
							},
							{
								...finish,
								finishReason: { unified: "tool-calls", raw: "tool_calls" },
							},
						]
					: [finish],
			);
		},
	});
	await runModelAgent(
		{
			userId: "alice",
			modelId: "model",
			instructions: "Test",
			messages: [{ role: "user", content: "Inspect" }],
			tools: { inspect: tool({ inputSchema: z.object({}), execute }) },
			knownTools: ["inspect"],
			signal: new AbortController().signal,
			onStep: async () => {},
			onEvent: async () => {},
		},
		{ model },
	);
	expect(model.doStreamCalls).toHaveLength(3);
	expect(execute).toHaveBeenCalledOnce();
});

it("does not retry after streaming has exposed output", async () => {
	const model = new MockLanguageModelV4({
		doStream: stream([
			{ type: "text-start", id: "reply" },
			{ type: "text-delta", id: "reply", delta: "Started" },
			{
				type: "error",
				error: new APICallError({
					message: "private stream failure",
					url: "https://example.com",
					requestBodyValues: {},
					statusCode: 503,
				}),
			},
		]),
	});
	await expect(
		runModelAgent(
			{
				userId: "alice",
				modelId: "model",
				instructions: "Test",
				messages: [{ role: "user", content: "Inspect" }],
				tools: {},
				signal: new AbortController().signal,
				onStep: async () => {},
				onEvent: async () => {},
			},
			{ model },
		),
	).rejects.toThrow();
	expect(model.doStreamCalls).toHaveLength(1);
});

it("turns a provider rate limit into an actionable error without echoing its response", async () => {
	mocks.model.mockReturnValue(
		new MockLanguageModelV4({
			doStream: async () => {
				throw new APICallError({
					message: "secret-provider-response",
					url: "https://example.com/v1/chat/completions",
					requestBodyValues: {},
					statusCode: 429,
				});
			},
		}),
	);
	const message = await run([]).then(
		() => "",
		(error: Error) => error.message,
	);
	expect(message).toContain("rate limit");
	expect(message).not.toContain("secret-provider-response");
});

it("requires the exact streamed verification tool and never executes it", async () => {
	mocks.model.mockReturnValue(
		new MockLanguageModelV4({
			doStream: stream([
				{
					type: "tool-call",
					toolCallId: "probe",
					toolName: "connection_check",
					input: '{"value":"ok"}',
				},
				{
					...finish,
					finishReason: { unified: "tool-calls", raw: "tool_calls" },
				},
			]),
		}),
	);
	await Effect.runPromise(verifyApiModel("alice", "connection", "model"));
	expect(mocks.verified).toHaveBeenCalledWith(
		"alice",
		"connection",
		"revision",
		"model",
	);
});

it("does not verify a text-only completion", async () => {
	mocks.model.mockReturnValue(
		new MockLanguageModelV4({
			doStream: stream([
				{ type: "text-start", id: "a" },
				{ type: "text-delta", id: "a", delta: "ok" },
				{ type: "text-end", id: "a" },
				finish,
			]),
		}),
	);
	await expect(
		Effect.runPromise(verifyApiModel("alice", "connection", "model")),
	).rejects.toThrow();
	expect(mocks.verified).not.toHaveBeenCalled();
});

it("sends the requested reasoning effort to Anthropic models instead of their default", async () => {
	mocks.load.mockResolvedValue({
		id: "connection",
		provider: "anthropic",
		revision: "revision",
		baseUrl: "https://api.anthropic.com/v1",
		sealedCredential: "sealed",
		models: [
			{
				id: "claude-opus-5-5",
				toolStreamingVerified: true,
				contextWindow: 1_000_000,
			},
		],
	});
	const model = new MockLanguageModelV4({
		doStream: async () => stream([finish]),
	});
	mocks.model.mockReturnValue(model);
	await runApiAgent({
		userId: "alice",
		connectionId: "connection",
		modelId: "claude-opus-5-5",
		reasoning: "max",
		messages: [{ role: "user", content: "Test" }],
		instructions: "Test instructions",
		tools: {},
		signal: new AbortController().signal,
		onEvent: async () => {},
		onStep: async () => {},
	});
	expect(model.doStreamCalls[0]?.providerOptions?.anthropic).toMatchObject({
		effort: "max",
	});
});

it("keeps sampling after a commentary progress note until the final answer", async () => {
	const responses = [
		[
			{
				type: "text-start" as const,
				id: "note",
				providerMetadata: { openai: { itemId: "note", phase: "commentary" } },
			},
			{ type: "text-delta" as const, id: "note", delta: "I'll build it next." },
			{
				type: "text-end" as const,
				id: "note",
				providerMetadata: { openai: { itemId: "note", phase: "commentary" } },
			},
			finish,
		],
		[
			{
				type: "text-start" as const,
				id: "answer",
				providerMetadata: {
					openai: { itemId: "answer", phase: "final_answer" },
				},
			},
			{ type: "text-delta" as const, id: "answer", delta: "Done." },
			{
				type: "text-end" as const,
				id: "answer",
				providerMetadata: {
					openai: { itemId: "answer", phase: "final_answer" },
				},
			},
			finish,
		],
	];
	let call = 0;
	const model = new MockLanguageModelV4({
		doStream: async () => stream(responses[Math.min(call++, 1)]),
	});
	const messages = await runModelAgent(
		{
			userId: "alice",
			modelId: "gpt-6.1-sol",
			instructions: "Implement",
			messages: [{ role: "user", content: "Fixture" }],
			tools: {},
			signal: new AbortController().signal,
			onEvent: async () => {},
			onStep: async () => {},
		},
		{ model },
	);
	expect(call).toBe(2);
	expect(JSON.stringify(messages)).toContain("Done.");
});

it("recognizes only a trailing commentary message without tool calls as unfinished", () => {
	const note = (phase: string) => ({
		role: "assistant" as const,
		content: [
			{
				type: "text" as const,
				text: "x",
				providerOptions: { openai: { phase } },
			},
		],
	});
	expect(endsWithCommentary([note("commentary")])).toBe(true);
	expect(endsWithCommentary([note("final_answer")])).toBe(false);
	expect(endsWithCommentary([{ role: "assistant", content: "plain" }])).toBe(
		false,
	);
	expect(
		endsWithCommentary([
			{
				role: "assistant",
				content: [
					...note("commentary").content,
					{ type: "tool-call", toolCallId: "c", toolName: "t", input: {} },
				],
			},
		]),
	).toBe(false);
});
