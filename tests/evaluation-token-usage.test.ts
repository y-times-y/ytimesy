import { expect, it } from "vitest";
import {
	evaluationObservedTokens,
	evaluationTokenUsage,
} from "../benchmarks/evaluation/token-usage";
import type { ApiAgentEvent } from "../src/domain/api-agent-event";

it("uses the final cumulative usage including compaction without double counting cached input", () => {
	const usage = (inputTokens: number, outputTokens: number): ApiAgentEvent => ({
		type: "usage",
		usage: {
			inputTokens,
			outputTokens,
			cacheReadTokens: 50,
			uncachedInputTokens: inputTokens - 50,
			cacheWriteTokens: 0,
		},
	});
	const events = [usage(100, 10), usage(150, 20), usage(300, 30)];
	expect(evaluationObservedTokens(events)).toBe(330);
	expect(evaluationTokenUsage(events)?.inputTokens).toBe(300);
});

it("allows the first request but fails closed when reported usage is incomplete", () => {
	expect(evaluationObservedTokens([])).toBe(0);
	expect(() =>
		evaluationObservedTokens([
			{
				type: "usage",
				usage: {
					inputTokens: null,
					outputTokens: 10,
					cacheReadTokens: null,
					uncachedInputTokens: null,
					cacheWriteTokens: null,
				},
			},
		]),
	).toThrow("unavailable");
});
