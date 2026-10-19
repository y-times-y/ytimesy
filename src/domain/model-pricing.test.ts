import { describe, expect, it } from "vitest";
import {
	KNOWN_MODEL_PRICES,
	modelBilling,
	pricedModelId,
	usageCostUsd,
} from "./model-pricing";

describe("pricedModelId", () => {
	it("maps Claude's direct and Bedrock ids onto the catalog id", () => {
		expect(pricedModelId("claude-opus-5-5")).toBe("claude-opus-5.5");
		expect(pricedModelId("claude-sonnet-5-5")).toBe("claude-sonnet-5.5");
		expect(pricedModelId("anthropic.claude-opus-5-5")).toBe("claude-opus-5.5");
		expect(pricedModelId("us.anthropic.claude-opus-5-5-v1:0")).toBe(
			"claude-opus-5.5",
		);
	});

	it("leaves other ids as they were", () => {
		expect(pricedModelId("gpt-6.1-sol")).toBe("gpt-6.1-sol");
		expect(pricedModelId("codex:gpt-6.1-sol")).toBe("gpt-6.1-sol");
		expect(pricedModelId("anthropic/claude-opus-5.5")).toBe(
			"anthropic/claude-opus-5.5",
		);
		expect(pricedModelId("google/gemini-3.8-flash:free")).toBe(
			"google/gemini-3.8-flash",
		);
		// A dated snapshot is a different id, never guessed onto a price.
		expect(pricedModelId("claude-sonnet-4-5-20250929")).toBe(
			"claude-sonnet-4-5-20250929",
		);
	});
});

describe("modelBilling", () => {
	it("prices Claude's direct API ids", () => {
		for (const [id, catalog] of [
			["claude-opus-5-5", "anthropic/claude-opus-5.5"],
			["claude-sonnet-5-5", "anthropic/claude-sonnet-5.5"],
			["anthropic.claude-opus-5-5", "anthropic/claude-opus-5.5"],
		] as const)
			expect(modelBilling({ harness: "api", modelId: id })).toEqual({
				kind: "tokens",
				price: KNOWN_MODEL_PRICES[catalog],
			});
	});

	it("gives a dollar cost for a direct Claude usage record", () => {
		const cost = usageCostUsd(
			{
				inputTokens: 1_000_000,
				outputTokens: 100_000,
				uncachedInputTokens: 200_000,
				cacheReadTokens: 700_000,
				cacheWriteTokens: 100_000,
			},
			modelBilling({ harness: "api", modelId: "claude-opus-5-5" }),
		);
		// 0.2M x $4 + 0.7M x $0.20 + 0.1M x $5 + 0.1M x $20
		expect(cost).toBeCloseTo(0.8 + 0.14 + 0.5 + 2, 6);
	});

	it("still has no price for an unknown model", () => {
		expect(
			modelBilling({ harness: "api", modelId: "claude-opus-9-9" }).price,
		).toBeNull();
	});
});
