import type { ApiTokenUsage } from "./api-token-usage";
import { parseModelRouteId } from "./model-connection";

/** USD per million tokens. Cache prices default to the input price when unknown. */
export type ModelPrice = {
	readonly input: number;
	readonly output: number;
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
};

/**
 * List prices we know (per million tokens). A model missing here has no
 * dollar estimate: its cost shows as tokens only, never as a guess. Models
 * served through OpenRouter report their own cost, which wins over this.
 */
export const KNOWN_MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
	"anthropic/claude-sonnet-5.5": {
		input: 3,
		output: 15,
		cacheRead: 0.3,
		cacheWrite: 3.75,
	},
	"anthropic/claude-opus-5.5": {
		input: 4,
		output: 20,
		cacheRead: 0.4,
		cacheWrite: 5,
	},
	"google/gemini-3.8-flash": { input: 0.6, output: 3.5, cacheRead: 0.15 },
	"deepseek/deepseek-v4.1-flash": { input: 0.4, output: 1.6, cacheRead: 0.04 },
	"openai/gpt-6.1-sol": { input: 2.5, output: 10, cacheRead: 0.25 },
};

/** How a route is billed: per token (with a known or unknown price) or by the user's plan. */
export type ModelBilling =
	| { readonly kind: "plan" }
	| { readonly kind: "tokens"; readonly price: ModelPrice | null };

/** The bare model id for a route id (`api/<connection>/<model>`), a `codex:` id or a plain id. */
export function pricedModelId(routeOrModelId: string) {
	const route = parseModelRouteId(routeOrModelId);
	const id = route?.modelId ?? routeOrModelId.replace(/^codex:/, "");
	return id.replace(/:free$/, "");
}

export function modelBilling(input: {
	readonly harness: "codex" | "api";
	readonly modelId: string | null;
}): ModelBilling {
	if (input.harness === "codex") return { kind: "plan" };
	if (!input.modelId) return { kind: "tokens", price: null };
	if (/:free$/.test(input.modelId))
		return { kind: "tokens", price: { input: 0, output: 0 } };
	const id = pricedModelId(input.modelId);
	return {
		kind: "tokens",
		price:
			KNOWN_MODEL_PRICES[id] ??
			KNOWN_MODEL_PRICES[`openai/${id}`] ??
			KNOWN_MODEL_PRICES[`anthropic/${id}`] ??
			null,
	};
}

/**
 * Dollars for one usage record: the provider's reported cost when it gave
 * one, else list price × tokens, $0 for plan-billed routes, null when
 * neither is known.
 */
export function usageCostUsd(
	usage: ApiTokenUsage | null | undefined,
	billing: ModelBilling,
): number | null {
	if (!usage) return billing.kind === "plan" ? 0 : null;
	if (billing.kind === "plan") return 0;
	if (typeof usage.costUsd === "number") return usage.costUsd;
	const { price } = billing;
	if (!price || usage.inputTokens === null || usage.outputTokens === null)
		return null;
	const cacheRead = usage.cacheReadTokens ?? 0;
	const cacheWrite = usage.cacheWriteTokens ?? 0;
	const uncached =
		usage.uncachedInputTokens ??
		Math.max(0, usage.inputTokens - cacheRead - cacheWrite);
	return (
		(uncached * price.input +
			cacheRead * (price.cacheRead ?? price.input) +
			cacheWrite * (price.cacheWrite ?? price.input) +
			usage.outputTokens * price.output) /
		1_000_000
	);
}
