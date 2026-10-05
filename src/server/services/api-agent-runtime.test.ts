import { APICallError, simulateReadableStream, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { Effect } from "effect";
import { beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { nativeModelCompactor } from "../adapters/model-compaction";
import {
	type ApiAgentEvent,
	runApiAgent,
	runModelAgent,
} from "./api-agent-runtime";
import { runModelAgentStep } from "./model-agent-loop";
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

it.each([
	{ historyLength: 95_000, previousContext: undefined },
	{
		historyLength: 9_000,
		previousContext: { tokens: 32_000, modelContextWindow: 48_000 },
	},
])(
	"uses native compaction with estimated or measured context ($historyLength), checkpoints opaque state and never streams it as a response",
	async ({ historyLength, previousContext }) => {
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
											encryptedContent: "opaque-fixture",
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
	expect(events.some((event) => event.type === "tool-result")).toBe(true);
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

it("does not log raw provider failures, retry, or fall back", async () => {
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
