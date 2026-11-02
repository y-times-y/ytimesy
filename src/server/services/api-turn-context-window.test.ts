import { expect, it } from "vitest";
import { modelContextBudget } from "./api-agent-context";
import { apiTurnContextWindow } from "./api-agent-runtime";

const sol = {
	provider: "openai" as const,
	baseUrl: "https://api.openai.com/v1",
	modelId: "gpt-6.1-sol",
};

it("budgets a tiered API route within its standard window unless the larger one is chosen", () => {
	expect(apiTurnContextWindow({ ...sol, largeContext: false }, 1_050_000)).toBe(
		272_000,
	);
	expect(apiTurnContextWindow({ ...sol, largeContext: true }, 1_050_000)).toBe(
		1_050_000,
	);
	// Never above what the provider reports.
	expect(apiTurnContextWindow({ ...sol, largeContext: true }, 400_000)).toBe(
		400_000,
	);
	// An evaluation's direct call (no choice) keeps the reported window.
	expect(apiTurnContextWindow(sol, 1_050_000)).toBe(1_050_000);
});

it("leaves routes without an option, and the Grok plan, at their reported window", () => {
	expect(
		apiTurnContextWindow(
			{
				provider: "anthropic",
				baseUrl: "https://api.anthropic.com/v1",
				modelId: "claude-opus-5-5",
				largeContext: false,
			},
			1_000_000,
		),
	).toBe(1_000_000);
	expect(
		apiTurnContextWindow(
			{
				provider: "compatible",
				baseUrl: "https://api.x.ai/v1",
				modelId: "grok-4.7",
				largeContext: false,
				subscription: { provider: "xai", status: "ready" },
			},
			500_000,
		),
	).toBe(500_000);
});

it("compacts a long chat before the chosen window's limit", () => {
	const at = (largeContext: boolean) =>
		modelContextBudget({
			contextWindow: apiTurnContextWindow({ ...sol, largeContext }, 1_050_000),
			maxOutputTokens: 32_000,
		});
	const standard = at(false);
	// Below the 272K price tier, input and output together.
	expect(standard.inputLimitTokens + 32_000).toBeLessThanOrEqual(272_000);
	expect(standard.compactAtTokens).toBeLessThan(standard.inputLimitTokens);
	const large = at(true);
	expect(large.compactAtTokens).toBeGreaterThan(272_000);
	expect(large.inputLimitTokens).toBeLessThan(1_050_000);
});
