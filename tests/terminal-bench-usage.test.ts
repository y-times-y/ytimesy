import { expect, it } from "vitest";
import { terminalBenchUsage } from "../benchmarks/evaluation/terminal-bench-usage";

const item = (
	inputTokens: number | null,
	cacheReadTokens: number | null = 7,
) => ({
	kind: "userMessage",
	id: "request",
	text: "Fix it",
	apiUsage: {
		inputTokens,
		outputTokens: 3,
		cacheReadTokens,
		cacheWriteTokens: 0,
		uncachedInputTokens: inputTokens === null ? null : inputTokens - 7,
	},
});
it("counts final cumulative usage once for every leader and child turn", () => {
	expect(
		terminalBenchUsage([
			{ id: "leader", items: [item(8), item(10)] },
			{ id: "child", items: [item(20)] },
		]),
	).toEqual({
		inputTokens: 30,
		outputTokens: 6,
		cacheReadTokens: 14,
		totalTokens: 36,
		turns: 2,
	});
});
it("rejects missing metrics instead of treating them as zero", () => {
	expect(() => terminalBenchUsage([{ id: "child", items: [] }])).toThrow(
		"missing",
	);
	expect(() =>
		terminalBenchUsage([{ id: "child", items: [item(null)] }]),
	).toThrow("incomplete");
	expect(() =>
		terminalBenchUsage([{ id: "child", items: [item(10, null)] }]),
	).toThrow("incomplete");
});
it("rejects duplicate turn records", () => {
	expect(() =>
		terminalBenchUsage([
			{ id: "child", items: [item(10)] },
			{ id: "child", items: [item(10)] },
		]),
	).toThrow("Duplicate");
});
it("does not borrow a previous turn's usage when the current request has none", () => {
	expect(() =>
		terminalBenchUsage([
			{
				id: "failed-followup",
				items: [
					item(10),
					{ kind: "userMessage", id: "followup", text: "Continue" },
				],
			},
		]),
	).toThrow("missing");
});
