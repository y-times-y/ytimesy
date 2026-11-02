import { expect, it } from "vitest";
import { modelContextBudget } from "./api-agent-context";
import { apiTurnContextWindow } from "./api-agent-runtime";

const sol = {
	provider: "openai" as const,
	baseUrl: "https://api.openai.com/v1",
	modelId: "gpt-6.1-sol",
};

it("budgets a tiered API route exactly as before unless the cheaper tier is chosen", () => {
	// Existing chats and evaluations: the reported window, unchanged.
	expect(apiTurnContextWindow(sol, 1_050_000)).toBe(1_050_000);
	expect(
		apiTurnContextWindow({ ...sol, alternateContext: false }, 1_050_000),
	).toBe(1_050_000);
	expect(apiTurnContextWindow(sol, undefined)).toBe(undefined);
	expect(
		apiTurnContextWindow({ ...sol, alternateContext: true }, 1_050_000),
	).toBe(272_000);
	// Never above what the provider reports.
	expect(
		apiTurnContextWindow({ ...sol, alternateContext: true }, 200_000),
	).toBe(200_000);
});

it("ignores the choice on routes without an option, and on the Grok plan", () => {
	expect(
		apiTurnContextWindow(
			{
				provider: "anthropic",
				baseUrl: "https://api.anthropic.com/v1",
				modelId: "claude-opus-5-5",
				alternateContext: true,
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
				alternateContext: true,
				subscription: { provider: "xai", status: "ready" },
			},
			500_000,
		),
	).toBe(500_000);
});

it("compacts a long chat before the chosen window's limit", () => {
	const at = (alternateContext: boolean) =>
		modelContextBudget({
			contextWindow: apiTurnContextWindow(
				{ ...sol, alternateContext },
				1_050_000,
			),
			maxOutputTokens: 32_000,
		});
	expect(at(false)).toEqual(
		modelContextBudget({ contextWindow: 1_050_000, maxOutputTokens: 32_000 }),
	);
	const tier = at(true);
	// Below the 272K price tier, input and output together.
	expect(tier.inputLimitTokens + 32_000).toBeLessThanOrEqual(272_000);
	expect(tier.compactAtTokens).toBeLessThan(tier.inputLimitTokens);
	expect(at(false).compactAtTokens).toBeGreaterThan(272_000);
});
