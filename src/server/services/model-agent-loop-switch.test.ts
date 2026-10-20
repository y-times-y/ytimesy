import type { ModelMessage } from "ai";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { expect, it, vi } from "vitest";
import {
	ModelSwitchAtCompaction,
	runModelAgentStep,
	withoutToolSettings,
} from "./model-agent-loop";

const usage = {
	inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 2, text: 2, reasoning: 0 },
};

function textStream(text: string) {
	return {
		stream: simulateReadableStream({
			initialDelayInMs: null,
			chunkDelayInMs: null,
			chunks: [
				{ type: "text-start" as const, id: "t" },
				{ type: "text-delta" as const, id: "t", delta: text },
				{ type: "text-end" as const, id: "t" },
				{
					type: "finish" as const,
					usage,
					finishReason: { unified: "stop" as const, raw: "stop" },
				},
			],
		}),
	};
}

const history: ModelMessage[] = [
	{ role: "user", content: "Round 1 brief" },
	{ role: "assistant", content: "x".repeat(6_000) },
	{ role: "user", content: "Round 2/6 from your lead. Fix it." },
];

function input(
	switchAtCompaction: Parameters<
		typeof runModelAgentStep
	>[0]["switchAtCompaction"],
	messages = history,
) {
	return {
		userId: "owner",
		modelId: "gpt-6-luna",
		instructions: "Work",
		messages,
		toolSurface: "implementation" as const,
		tools: {},
		signal: new AbortController().signal,
		onEvent: vi.fn(async () => {}),
		onStep: vi.fn(async (_messages: ModelMessage[]) => {}),
		compactFirst: true,
		switchAtCompaction,
	};
}

const target = {
	spec: "codex:gpt-6.1-sol",
	reason: "it repeats make test",
	trigger: "pending" as const,
};

it("compacts a pending switch's round first into a neutral summary, saves it, and ends the run for the switch", async () => {
	const model = new MockLanguageModelV4({
		doStream: async () =>
			textStream("## Requirements and constraints\n- Fix it"),
	});
	const hook = vi.fn(async () => ({ target }));
	const run = input(hook);
	const error = await runModelAgentStep(run, {
		model,
		contextWindow: 200_000,
	}).catch((cause: unknown) => cause);
	expect(error).toBeInstanceOf(ModelSwitchAtCompaction);
	expect((error as ModelSwitchAtCompaction).target).toEqual(target);
	expect((error as ModelSwitchAtCompaction).compacted).toBe(true);
	expect(hook).toHaveBeenCalledWith(expect.objectContaining({ forced: true }));
	// One request: the summary; the step itself runs on the next model.
	expect(model.doStreamCalls).toHaveLength(1);
	const saved = JSON.stringify(run.onStep.mock.calls.at(-1)?.[0]);
	expect(saved).toContain("Summary of earlier conversation");
	expect(saved).toContain("Round 2/6 from your lead. Fix it.");
	expect(saved).not.toContain("x".repeat(6_000));
});

it("runs the step as usual when the hook names no model", async () => {
	const model = new MockLanguageModelV4({
		doStream: async () => textStream("Done"),
	});
	const run = input(vi.fn(async () => ({ target: null })));
	const result = await runModelAgentStep(run, {
		model,
		contextWindow: 200_000,
	});
	expect(result.outcome).toBe("completed");
	expect(model.doStreamCalls).toHaveLength(1);
	expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain(
		"x".repeat(6_000),
	);
});

it("switches on the whole history when a round's first compaction cannot run", async () => {
	const model = new MockLanguageModelV4({
		doStream: async () => textStream("unused"),
	});
	// A single request: nothing before it to summarize.
	const run = input(
		vi.fn(async () => ({ target })),
		[{ role: "user", content: "Round 1 brief" }],
	);
	const error = await runModelAgentStep(run, {
		model,
		contextWindow: 200_000,
	}).catch((cause: unknown) => cause);
	expect(error).toBeInstanceOf(ModelSwitchAtCompaction);
	expect((error as ModelSwitchAtCompaction).compacted).toBe(false);
	expect(model.doStreamCalls).toHaveLength(0);
});

it("drops the parallel tool call option from one-off requests", () => {
	expect(
		withoutToolSettings({
			providerOptions: {
				openai: { instructions: "x", parallelToolCalls: true },
			},
		}),
	).toEqual({ providerOptions: { openai: { instructions: "x" } } });
	const plain = { system: "x" };
	expect(withoutToolSettings(plain)).toBe(plain);
});

it("keeps the summary when the context archive fails, and charges the decision's usage to the run", async () => {
	const model = new MockLanguageModelV4({
		doStream: async () =>
			textStream("## Requirements and constraints\n- Fix it"),
	});
	const decisionUsage = {
		inputTokens: 900,
		outputTokens: 30,
		uncachedInputTokens: 900,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	};
	const run = {
		...input(vi.fn(async () => ({ target, usage: decisionUsage }))),
		// The rehearsal has no archive storage: the upload throws.
		archiveHistory: vi.fn(async () => {
			throw new Error("storage is not configured");
		}),
	};
	const error = await runModelAgentStep(run, {
		model,
		contextWindow: 200_000,
	}).catch((cause: unknown) => cause);
	expect(error).toBeInstanceOf(ModelSwitchAtCompaction);
	expect((error as ModelSwitchAtCompaction).compacted).toBe(true);
	const saved = JSON.stringify(run.onStep.mock.calls.at(-1)?.[0]);
	expect(saved).toContain("Summary of earlier conversation");
	expect(saved).not.toContain("Original context archive");
	const usages = (
		run.onEvent.mock.calls as unknown as [
			{ type: string; usage?: { inputTokens: number } },
		][]
	)
		.map(([event]) => event)
		.filter((event) => event.type === "usage");
	// The decision's tokens first, then the summary's on top.
	expect(usages[0]?.usage?.inputTokens).toBe(900);
	expect(usages.at(-1)?.usage?.inputTokens).toBe(903);
});
