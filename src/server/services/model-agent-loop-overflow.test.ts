import type { ModelMessage } from "ai";
import { APICallError, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { expect, it, vi } from "vitest";
import {
	apiModelFailureMessage,
	IncompleteAgentTurn,
} from "#/domain/api-turn-failure";
import {
	OUTPUT_LIMIT_CONTINUE_NOTE,
	overflowCompactionBudget,
	runModelAgent,
	runModelAgentStep,
} from "./model-agent-loop";

const usage = {
	inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 2, text: 2, reasoning: 0 },
};

function textStream(text: string, finish: "stop" | "length") {
	return {
		stream: simulateReadableStream({
			initialDelayInMs: null,
			chunkDelayInMs: null,
			chunks: [
				...(text
					? [
							{ type: "text-start" as const, id: "t" },
							{ type: "text-delta" as const, id: "t", delta: text },
							{ type: "text-end" as const, id: "t" },
						]
					: []),
				{
					type: "finish" as const,
					usage,
					finishReason: { unified: finish, raw: finish },
				},
			],
		}),
	};
}

const anthropicOverflow = () =>
	new APICallError({
		message: "prompt is too long: 215000 tokens > 200000 maximum",
		url: "https://api.anthropic.com/v1/messages",
		requestBodyValues: {},
		statusCode: 400,
		responseBody:
			'{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 215000 tokens > 200000 maximum"}}',
		isRetryable: false,
	});

const summary = {
	doGenerate: async () => ({
		content: [
			{
				type: "text" as const,
				text: "## Requirements and constraints\n- Fix it",
			},
		],
		finishReason: { unified: "stop" as const, raw: "stop" },
		usage,
		warnings: [],
	}),
};

const history: ModelMessage[] = [
	{ role: "user", content: "Earlier request" },
	{ role: "assistant", content: "x".repeat(6_000) },
	{ role: "user", content: "Fix it" },
];

function input(messages = history) {
	return {
		userId: "owner",
		modelId: "model",
		instructions: "Work",
		messages,
		toolSurface: "implementation" as const,
		tools: {},
		signal: new AbortController().signal,
		onEvent: vi.fn(async () => {}),
		onStep: vi.fn(async () => {}),
	};
}

it("compacts and retries a step the provider rejected for its context size", async () => {
	let calls = 0;
	const model = new MockLanguageModelV4({
		...summary,
		doStream: async () => {
			if (calls++ === 0) throw anthropicOverflow();
			return textStream("Done", "stop");
		},
	});
	const run = input();
	const result = await runModelAgentStep(run, {
		model,
		contextWindow: 200_000,
	});
	expect(result.outcome).toBe("completed");
	expect(model.doStreamCalls).toHaveLength(2);
	expect(model.doGenerateCalls).toHaveLength(1);
	const retried = JSON.stringify(model.doStreamCalls[1].prompt);
	expect(retried).toContain("Summary of earlier conversation");
	expect(retried).not.toContain("x".repeat(6_000));
	expect(retried).toContain("Fix it");
});

it("fails as before when the compacted step is rejected again", async () => {
	const model = new MockLanguageModelV4({
		...summary,
		doStream: async () => {
			throw anthropicOverflow();
		},
	});
	const error = await runModelAgentStep(input(), {
		model,
		contextWindow: 200_000,
	}).catch((cause: unknown) => cause);
	expect(model.doStreamCalls).toHaveLength(2);
	expect(apiModelFailureMessage(error)).toContain("even after compacting");
});

it("treats a length stop without output as an exhausted context and retries once", async () => {
	let calls = 0;
	const model = new MockLanguageModelV4({
		...summary,
		doStream: async () =>
			calls++ === 0 ? textStream("", "length") : textStream("Done", "stop"),
	});
	const result = await runModelAgentStep(input(), {
		model,
		contextWindow: 200_000,
	});
	expect(result.outcome).toBe("completed");
	expect(model.doGenerateCalls).toHaveLength(1);
	// The empty, cut-off response is not part of the continued history.
	expect(
		result.messages.filter((message) => message.role === "assistant").at(-1),
	).toMatchObject({ content: [{ type: "text", text: "Done" }] });
});

it("continues an answer cut off at the output limit once, then gives up", async () => {
	let calls = 0;
	const model = new MockLanguageModelV4({
		doStream: async () =>
			calls++ === 0
				? textStream("First half", "length")
				: textStream("second half", "stop"),
	});
	const messages = await runModelAgent(input([history[2]]), { model });
	expect(messages.map((message) => message.role)).toEqual([
		"user",
		"assistant",
		"user",
		"assistant",
	]);
	expect(messages[2]).toEqual({
		role: "user",
		content: OUTPUT_LIMIT_CONTINUE_NOTE,
	});

	const truncating = new MockLanguageModelV4({
		doStream: async () => textStream("Again cut", "length"),
	});
	await expect(
		runModelAgent(input([history[2]]), { model: truncating }),
	).rejects.toBeInstanceOf(IncompleteAgentTurn);
	expect(truncating.doStreamCalls).toHaveLength(2);
});

it("compacts below what the provider reported, or below 60% of the input limit", () => {
	const budget = { inputLimitTokens: 150_000, compactAtTokens: 120_000 };
	expect(overflowCompactionBudget(budget, {})).toEqual({
		inputLimitTokens: 150_000,
		compactAtTokens: 90_000,
	});
	expect(overflowCompactionBudget(budget, { limitTokens: 100_000 })).toEqual({
		inputLimitTokens: 100_000,
		compactAtTokens: 60_000,
	});
});
