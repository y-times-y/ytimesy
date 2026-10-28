import { type ModelMessage, simulateReadableStream, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	apiModelFailureMessage,
	HarnessRuntimeFailure,
} from "#/domain/api-turn-failure";
import { runModelAgent } from "./model-agent-loop";

// No provider-measured usage: compaction follows the history estimate alone.
const usage = {
	inputTokens: {
		total: undefined,
		noCache: undefined,
		cacheRead: undefined,
		cacheWrite: undefined,
	},
	outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};
type StreamPart =
	Awaited<
		ReturnType<typeof MockLanguageModelV4.prototype.doStream>
	>["stream"] extends ReadableStream<infer T>
		? T
		: never;
const stream = (chunks: StreamPart[]) => ({
	stream: simulateReadableStream({
		chunks,
		initialDelayInMs: null,
		chunkDelayInMs: null,
	}),
});

/** One Responses-route step: encrypted reasoning, then a tool call. */
const toolStep = (step: number): StreamPart[] => [
	{
		type: "reasoning-start",
		id: `rs_${step}`,
		providerMetadata: {
			openai: {
				itemId: `rs_${step}`,
				reasoningEncryptedContent: `encrypted-${step}`,
			},
		},
	},
	{ type: "reasoning-delta", id: `rs_${step}`, delta: `Plan ${step}` },
	{ type: "reasoning-end", id: `rs_${step}` },
	{
		type: "tool-call",
		toolCallId: `call_${step}`,
		toolName: "run",
		input: JSON.stringify({ step }),
		providerMetadata: { openai: { itemId: `fc_${step}` } },
	},
	{
		type: "finish",
		usage,
		finishReason: { unified: "tool-calls", raw: "tool_calls" },
	},
];
const answer: StreamPart[] = [
	{ type: "text-start", id: "a" },
	{ type: "text-delta", id: "a", delta: "Task complete." },
	{ type: "text-end", id: "a" },
	{ type: "finish", usage, finishReason: { unified: "stop", raw: "stop" } },
];
const summary = {
	doGenerate: async () => ({
		content: [
			{
				type: "text" as const,
				text: "## Requirements and constraints\n- Finish the task",
			},
		],
		finishReason: { unified: "stop" as const, raw: "stop" },
		usage,
		warnings: [],
	}),
};

/** Every tool call in a prompt has its result and every result its call. */
function pairedToolSequences(prompt: unknown) {
	const calls = new Set<string>();
	const results = new Set<string>();
	for (const message of prompt as {
		role: string;
		content: string | { type: string; toolCallId?: string }[];
	}[]) {
		if (typeof message.content === "string") continue;
		for (const part of message.content) {
			if (part.type === "tool-call" && part.toolCallId)
				calls.add(part.toolCallId);
			if (part.type === "tool-result" && part.toolCallId)
				results.add(part.toolCallId);
		}
	}
	return [...calls].sort().join() === [...results].sort().join();
}

const STEPS = 8;

function longTask(policy: "whole-turns" | "bound-prefix") {
	let call = 0;
	const model = new MockLanguageModelV4({
		...summary,
		doStream: async () => stream(++call > STEPS ? answer : toolStep(call)),
	});
	// Each output is ~3,000 estimated tokens: one task outgrows the budget.
	const run = tool({
		inputSchema: z.object({ step: z.number() }),
		execute: async ({ step }) => `output ${step} ${"y".repeat(9_000)}`,
	});
	const onStep = vi.fn(async (_messages: ModelMessage[]) => {});
	const done = runModelAgent(
		{
			userId: "owner",
			modelId: "gpt-6-astra",
			instructions: "Work",
			// The benchmark shape: one user turn, no earlier turns to retire.
			messages: [{ role: "user", content: "Solve the task" }],
			tools: { run },
			signal: new AbortController().signal,
			onEvent: async () => {},
			onStep,
		},
		{
			model,
			contextWindow: 48_000,
			workingContextTokens: 12_000,
			fallbackContextPolicy: policy,
		},
	);
	return { model, done };
}

afterEach(() => {
	vi.restoreAllMocks();
});

it("compacts one long active turn on the Responses-route policy and keeps working", async () => {
	const { model, done } = longTask("whole-turns");
	const messages = await done;
	expect(messages.at(-1)).toMatchObject({
		role: "assistant",
		content: [{ type: "text", text: "Task complete." }],
	});
	// Our own summary ran at least once, and every step was sampled.
	expect(model.doGenerateCalls.length).toBeGreaterThan(0);
	expect(model.doStreamCalls).toHaveLength(STEPS + 1);
	for (const request of model.doStreamCalls) {
		expect(pairedToolSequences(request.prompt)).toBe(true);
		// The task stays verbatim in every request.
		expect(JSON.stringify(request.prompt)).toContain("Solve the task");
	}
	// The last tool step kept its reasoning with its call: a reasoning item
	// is never sent without the output item it produced, and vice versa.
	const last = model.doStreamCalls.at(-1)?.prompt ?? [];
	const assistants = last.filter(
		(message) => message.role === "assistant" && Array.isArray(message.content),
	);
	const latest = assistants.at(-1);
	expect(latest?.content).toEqual([
		expect.objectContaining({ type: "reasoning" }),
		expect.objectContaining({ type: "tool-call", toolCallId: `call_${STEPS}` }),
	]);
	// Earlier steps were retired into the summary, not kept.
	expect(JSON.stringify(last)).not.toContain('call_1"');
	expect(JSON.stringify(last)).toContain("Summary of earlier conversation");
});

it("reports a compaction it cannot do as the harness's own failure, never a provider one", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const { done } = longTask("bound-prefix");
	const failure = await done.catch((error: unknown) => error);
	expect(failure).toBeInstanceOf(HarnessRuntimeFailure);
	expect((failure as HarnessRuntimeFailure).stage).toBe("context-compaction");
	const message = apiModelFailureMessage(failure);
	expect(message).toMatch(
		/^Context compaction failed: The active turn cannot be safely compacted by this provider/,
	);
	expect(message).toContain("not a model or provider failure");
	expect(warn).toHaveBeenCalledWith(
		"Harness runtime failed",
		expect.objectContaining({
			name: "HarnessRuntimeFailure",
			stage: "context-compaction",
			message: expect.stringContaining("Context compaction failed"),
		}),
	);
	expect(warn).not.toHaveBeenCalledWith(
		"Model provider failed",
		expect.anything(),
	);
});

it("continues from the provider's in-stream checkpoint without resending what it replaced", async () => {
	let call = 0;
	const model = new MockLanguageModelV4({
		...summary,
		doStream: async () => {
			call++;
			if (call === 2)
				return stream([
					// OpenAI context_management: the input was compacted in-stream.
					{
						type: "custom",
						kind: "openai.compaction",
						providerMetadata: {
							openai: { itemId: "cmp_1", encryptedContent: "checkpoint" },
						},
					},
					...toolStep(2),
				]);
			return stream(call === 1 ? toolStep(1) : answer);
		},
	});
	const run = tool({
		inputSchema: z.object({ step: z.number() }),
		execute: async ({ step }) => `output ${step}`,
	});
	const archiveHistory = vi.fn(async () => "archive:fixture");
	const messages = await runModelAgent(
		{
			userId: "owner",
			modelId: "gpt-6-astra",
			instructions: "Work",
			messages: [{ role: "user", content: "Solve the task" }],
			tools: { run },
			signal: new AbortController().signal,
			onEvent: async () => {},
			onStep: async () => {},
			archiveHistory,
			isUserRequest: (message) =>
				message.role === "user" && message.content === "Solve the task",
		},
		{ model, contextWindow: 1_050_000, fallbackContextPolicy: "whole-turns" },
	);
	expect(model.doGenerateCalls).toHaveLength(0);
	expect(archiveHistory).toHaveBeenCalledOnce();
	const third = model.doStreamCalls[2].prompt;
	expect(pairedToolSequences(third)).toBe(true);
	const text = JSON.stringify(third);
	// Step 1 (before the checkpoint) is not resent; the request is, verbatim.
	expect(text).not.toContain("call_1");
	expect(text).toContain("Solve the task");
	const roles = third.map((message) => message.role);
	expect(roles).toEqual(["system", "user", "assistant", "assistant", "tool"]);
	expect(third[2].content).toEqual([
		expect.objectContaining({ type: "custom", kind: "openai.compaction" }),
	]);
	expect(messages.at(-1)).toMatchObject({ role: "assistant" });
});
