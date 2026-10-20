import { describe, expect, it } from "vitest";
import { addApiTokenUsage, requestTokenUsage } from "./api-token-usage";
import {
	longContextThreshold,
	modelBilling,
	modelPrice,
	referenceTokenPrice,
	usageCostUsd,
} from "./model-pricing";
import {
	BUDGET_WEIGHT_MAX,
	BUDGET_WEIGHT_MIN,
	budgetTokenWeight,
} from "./subagent-usage";

const request = (input: number, cached: number, output: number) => ({
	inputTokens: input,
	outputTokens: output,
	uncachedInputTokens: input - cached,
	cacheReadTokens: cached,
	cacheWriteTokens: 0,
});

describe("price table", () => {
	it("finds a price by OpenRouter id, direct id, Codex slug or route id", () => {
		const luna = modelPrice("openai/gpt-6-luna");
		expect(luna).toMatchObject({ input: 0.1, cacheRead: 0.01, output: 0.5 });
		expect(modelPrice("gpt-6-luna")).toBe(luna);
		expect(modelPrice("codex:gpt-6-luna")).toBe(luna);
		expect(modelPrice("claude-opus-5-5")).toMatchObject({ input: 4 });
		expect(modelPrice("gemini-3.8-flash")).toMatchObject({ input: 0.75 });
		expect(
			modelPrice(
				`api/${"5".repeat(8)}-5555-4555-8555-${"5".repeat(12)}/${encodeURIComponent("moonshotai/kimi-k3")}`,
			),
		).toMatchObject({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 });
		expect(modelPrice("acme/unknown")).toBeNull();
	});

	it("applies announced price changes from their date", () => {
		const before = Date.parse("2026-11-30T12:00:00Z");
		const after = Date.parse("2026-12-01T00:00:00Z");
		expect(modelPrice("google/gemini-4-argon", before)?.input).toBe(2);
		expect(modelPrice("google/gemini-4-argon", after)?.input).toBe(4);
		expect(
			modelPrice("google/gemini-3.8-flash", Date.parse("2027-01-02"))?.output,
		).toBe(7.5);
	});

	it("has the long-context thresholds the providers list", () => {
		expect(longContextThreshold("gpt-6.1-sol")).toBe(272_000);
		expect(longContextThreshold("anthropic/claude-haiku-5.5")).toBe(100_000);
		expect(longContextThreshold("anthropic/claude-opus-5.5")).toBeNull();
		expect(longContextThreshold(null)).toBeNull();
	});
});

describe("per-request tiered pricing", () => {
	const sol = modelBilling({ harness: "api", modelId: "openai/gpt-6.1-sol" });

	it("prices requests above 272K at Sol's long-context tier", () => {
		const threshold = longContextThreshold("openai/gpt-6.1-sol");
		const small = requestTokenUsage(request(100_000, 80_000, 1_000), threshold);
		const large = requestTokenUsage(
			request(300_000, 250_000, 2_000),
			threshold,
		);
		expect(small.longContext).toBeUndefined();
		expect(large.longContext).toMatchObject({
			requests: 1,
			inputTokens: 300_000,
		});
		const turn = addApiTokenUsage(small, large);
		expect(turn.requests).toBe(2);
		expect(turn.longContext).toMatchObject({
			aboveInputTokens: 272_000,
			requests: 1,
			cacheReadTokens: 250_000,
		});
		// Base: 20K × $2 + 80K × $0.10 + 1K × $10; long: 50K × $4 + 250K × $0.20 + 2K × $15.
		const base = (20_000 * 2 + 80_000 * 0.1 + 1_000 * 10) / 1e6;
		const long = (50_000 * 4 + 250_000 * 0.2 + 2_000 * 15) / 1e6;
		expect(usageCostUsd(turn, sol)).toBeCloseTo(base + long, 10);
		// Without the per-request split everything is priced at the base tier.
		const { longContext: _drop, ...flat } = turn;
		expect(usageCostUsd(flat, sol)).toBeLessThan(base + long);
	});

	it("ignores a split recorded for another threshold", () => {
		const turn = requestTokenUsage(request(150_000, 0, 0), 100_000);
		const opus = modelBilling({
			harness: "api",
			modelId: "anthropic/claude-opus-5.5",
		});
		expect(usageCostUsd(turn, opus)).toBeCloseTo(0.6);
	});

	it("keeps request counts and splits through accumulation", () => {
		let total = null as ReturnType<typeof addApiTokenUsage> | null;
		for (let index = 0; index < 3; index++)
			total = addApiTokenUsage(
				total,
				requestTokenUsage(request(400_000, 0, 10), 272_000),
			);
		expect(total?.requests).toBe(3);
		expect(total?.longContext?.requests).toBe(3);
		expect(total?.longContext?.inputTokens).toBe(1_200_000);
	});
});

describe("budget weights", () => {
	it("weights a child's tokens by its price relative to the builder's, clamped", () => {
		expect(budgetTokenWeight("gpt-6.1-sol", "gpt-6.1-sol")).toBe(1);
		expect(budgetTokenWeight("gpt-6-luna", "anthropic/claude-opus-5.5")).toBe(
			BUDGET_WEIGHT_MIN,
		);
		expect(budgetTokenWeight("gpt-6-astra", "gpt-6-luna")).toBe(
			BUDGET_WEIGHT_MAX,
		);
		const sonnetVsSol = budgetTokenWeight(
			"anthropic/claude-sonnet-5.5",
			"openai/gpt-6.1-sol",
		);
		expect(sonnetVsSol).toBeCloseTo(
			referenceTokenPrice({ input: 2, output: 10, cacheRead: 0.1 }) /
				referenceTokenPrice({ input: 2, output: 10, cacheRead: 0.1 }),
		);
		expect(budgetTokenWeight("acme/unknown", "gpt-6.1-sol")).toBe(1);
		expect(budgetTokenWeight("x/y:free", "gpt-6.1-sol")).toBe(
			BUDGET_WEIGHT_MIN,
		);
		expect(budgetTokenWeight("gpt-6-luna", undefined)).toBe(1);
	});
});
