import { type ModelMessage, simulateReadableStream, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import {
	apiTurnFailureMessage,
	InitialAgentReadFailure,
} from "#/domain/api-turn-failure";
import { prefetchInitialAgentReads } from "./agent-initial-reads";
import { runModelAgentStep } from "./model-agent-loop";

const fresh: ModelMessage[] = [
	{ role: "user", content: "The exact original request" },
];

it("prefetches a builder's actual working-tree state once using the existing read tool", async () => {
	const input = readTools();
	const inspect = vi
		.fn()
		.mockResolvedValue({ tracked: "user edit", untracked: ["notes.md"] });
	const tools = {
		...input.tools,
		inspect_changes: tool({ inputSchema: z.object({}), execute: inspect }),
	};
	const options = {
		tools,
		signal: new AbortController().signal,
		onEvent: async () => {},
	};
	const messages = await prefetchInitialAgentReads({
		...options,
		messages: fresh,
	});
	expect(inspect).toHaveBeenCalledOnce();
	expect(JSON.stringify(messages)).toContain("user edit");
	expect(JSON.stringify(messages)).toContain("notes.md");
	await prefetchInitialAgentReads({ ...options, messages });
	expect(inspect).toHaveBeenCalledOnce();
});

it("keeps identical fresh OpenAI preflight prefixes independent of the task prompt", async () => {
	const input = readTools();
	const first = await prefetchInitialAgentReads({
		messages: fresh,
		tools: input.tools,
		cacheStablePrefix: true,
		signal: new AbortController().signal,
		onEvent: async () => {},
	});
	const otherRequest: ModelMessage[] = [
		{ role: "user", content: "Another exact contract" },
	];
	const second = await prefetchInitialAgentReads({
		messages: otherRequest,
		tools: input.tools,
		cacheStablePrefix: true,
		signal: new AbortController().signal,
		onEvent: async () => {},
	});
	expect(first.slice(0, -1)).toEqual(second.slice(0, -1));
	expect(first.at(-1)).toBe(fresh[0]);
	expect(second.at(-1)).toBe(otherRequest[0]);
	expect(JSON.stringify(first)).toContain("Exact mandatory body");
	expect(
		await prefetchInitialAgentReads({
			messages: first,
			tools: input.tools,
			cacheStablePrefix: true,
			signal: new AbortController().signal,
			onEvent: async () => {},
		}),
	).toBe(first);
});

function readTools() {
	const guidance = vi.fn().mockResolvedValue({
		instructions: [{ path: "AGENTS.md", content: "Exact mandatory body" }],
	});
	const environment = vi.fn().mockResolvedValue({ available: false });
	return {
		guidance,
		environment,
		tools: {
			read_repository_guidance: tool({
				inputSchema: z.object({ scope: z.string() }),
				execute: guidance,
			}),
			read_environment_report: tool({
				inputSchema: z.object({}),
				execute: environment,
			}),
		},
	};
}

it("uses only existing authorized reads and preserves actual complete results and the original request", async () => {
	const input = readTools();
	const onEvent = vi.fn();
	const messages = await prefetchInitialAgentReads({
		messages: fresh,
		tools: input.tools,
		signal: new AbortController().signal,
		onEvent,
	});
	expect(messages[0]).toBe(fresh[0]);
	expect(messages).toHaveLength(3);
	expect(input.guidance).toHaveBeenCalledWith(
		{ scope: "." },
		expect.objectContaining({ messages: fresh }),
	);
	expect(input.environment).toHaveBeenCalledOnce();
	expect(
		onEvent.mock.calls.filter(([event]) => event.type === "tool-call"),
	).toHaveLength(2);
	expect(
		onEvent.mock.calls.filter(([event]) => event.type === "tool-result"),
	).toHaveLength(2);
	expect(JSON.stringify(messages)).toContain("Exact mandatory body");
	const resumed = await prefetchInitialAgentReads({
		messages,
		tools: input.tools,
		signal: new AbortController().signal,
		onEvent,
	});
	expect(resumed).toBe(messages);
	expect(input.guidance).toHaveBeenCalledOnce();
});

it("does not invent missing tools or run after cancellation", async () => {
	const input = readTools();
	expect(
		await prefetchInitialAgentReads({
			messages: fresh,
			tools: {},
			signal: new AbortController().signal,
			onEvent: async () => {},
		}),
	).toBe(fresh);
	const signal = AbortSignal.abort(new Error("Cancelled"));
	await expect(
		prefetchInitialAgentReads({
			messages: fresh,
			tools: input.tools,
			signal,
			onEvent: async () => {},
		}),
	).rejects.toThrow("Cancelled");
	expect(input.guidance).not.toHaveBeenCalled();
});

it("checkpoints real preflight before the first inference, including full guidance", async () => {
	const input = readTools();
	const checkpoint = vi.fn();
	const model = new MockLanguageModelV4({
		provider: "openai.responses",
		doStream: async () => {
			expect(checkpoint).toHaveBeenCalledOnce();
			return {
				stream: simulateReadableStream({
					initialDelayInMs: null,
					chunkDelayInMs: null,
					chunks: [
						{ type: "text-start", id: "answer" },
						{ type: "text-delta", id: "answer", delta: "Ready" },
						{ type: "text-end", id: "answer" },
						{
							type: "finish",
							finishReason: { unified: "stop", raw: "stop" },
							usage: {
								inputTokens: {
									total: 1,
									noCache: 1,
									cacheRead: 0,
									cacheWrite: 0,
								},
								outputTokens: { total: 1, text: 1, reasoning: 0 },
							},
						},
					],
				}),
			};
		},
	});
	await runModelAgentStep(
		{
			userId: "alice",
			modelId: "fixture",
			messages: fresh,
			instructions: "Follow repository rules",
			tools: input.tools,
			signal: new AbortController().signal,
			onEvent: async () => {},
			onStep: checkpoint,
		},
		{ model, contextWindow: 128000, prefetchInitialReads: true },
	);
	expect(JSON.stringify(model.doStreamCalls[0].prompt)).toContain(
		"Exact mandatory body",
	);
	expect(JSON.stringify(model.doStreamCalls[0].prompt)).toContain(
		"The exact original request",
	);
	expect(model.doStreamCalls[0].prompt.at(-1)?.role).toBe("user");
});

it("does not infer or checkpoint fabricated guidance when its read fails", async () => {
	const input = readTools();
	input.guidance.mockRejectedValue(new Error("Guidance unavailable"));
	const model = new MockLanguageModelV4();
	const checkpoint = vi.fn();
	await expect(
		runModelAgentStep(
			{
				userId: "alice",
				modelId: "fixture",
				messages: fresh,
				instructions: "Follow repository rules",
				tools: input.tools,
				signal: new AbortController().signal,
				onEvent: async () => {},
				onStep: checkpoint,
			},
			{ model, contextWindow: 128000, prefetchInitialReads: true },
		),
	).rejects.toThrow(InitialAgentReadFailure);
	expect(model.doStreamCalls).toHaveLength(0);
	expect(checkpoint).not.toHaveBeenCalled();
});

it("settles started reads after cancellation without leaking the underlying error", async () => {
	const input = readTools();
	const controller = new AbortController();
	input.guidance.mockImplementation(async () => {
		controller.abort(new Error("Cancelled"));
		throw new Error("secret provider token");
	});
	const onEvent = vi.fn();
	await expect(
		prefetchInitialAgentReads({
			messages: fresh,
			tools: input.tools,
			signal: controller.signal,
			onEvent,
		}),
	).rejects.toThrow("Cancelled");
	const events = onEvent.mock.calls.map(([event]) => event);
	expect(events.filter((event) => event.type === "tool-result")).toHaveLength(
		events.filter((event) => event.type === "tool-call").length,
	);
	expect(JSON.stringify(events)).not.toContain("secret provider token");
	expect(
		apiTurnFailureMessage(
			"model",
			new InitialAgentReadFailure("read_repository_guidance"),
		),
	).toContain("Workspace preparation failed");
});

it("settles every initial read receipt when workspace preparation fails", async () => {
	const input = readTools();
	input.guidance.mockRejectedValue(new Error("Workspace preparation failed"));
	const onEvent = vi.fn();
	await expect(
		prefetchInitialAgentReads({
			messages: fresh,
			tools: input.tools,
			signal: new AbortController().signal,
			onEvent,
		}),
	).rejects.toThrow();
	const calls = onEvent.mock.calls
		.map(([event]) => event)
		.filter((event) => event.type === "tool-call");
	const results = onEvent.mock.calls
		.map(([event]) => event)
		.filter((event) => event.type === "tool-result");
	expect(results.map((event) => event.id).sort()).toEqual(
		calls.map((event) => event.id).sort(),
	);
	expect(results.some((event) => event.failed)).toBe(true);
});

it("prefetches a builder's environment report without a repository guidance tool", async () => {
	const { read_repository_guidance: _, ...tools } = readTools().tools;
	const environment = vi.fn().mockResolvedValue({ available: true });
	const messages = await prefetchInitialAgentReads({
		messages: fresh,
		tools: {
			...tools,
			read_environment_report: tool({
				inputSchema: z.object({}),
				execute: environment,
			}),
		},
		signal: new AbortController().signal,
		onEvent: async () => {},
	});
	expect(environment).toHaveBeenCalledOnce();
	expect(JSON.stringify(messages)).not.toContain("read_repository_guidance");
	expect(JSON.stringify(messages)).toContain("read_environment_report");
});
