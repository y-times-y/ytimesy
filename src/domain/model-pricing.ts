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
	// Anthropic list prices (claude-api reference, cached 2026-10-06).
	"anthropic/claude-sonnet-5.5": {
		input: 2,
		output: 10,
		cacheRead: 0.2,
		cacheWrite: 2.5,
	},
	"anthropic/claude-opus-5.5": {
		input: 4,
		output: 20,
		cacheRead: 0.2,
		cacheWrite: 5,
	},
	"google/gemini-3.8-flash": { input: 0.6, output: 3.5, cacheRead: 0.15 },
	"deepseek/deepseek-v4.1-flash": { input: 0.4, output: 1.6, cacheRead: 0.04 },
	// OpenAI Standard tier, developers.openai.com/api/docs/pricing, read
	// 2026-10-18 (verified). These are the short-context rates (requests up to
	// 272K input tokens). Above 272K the page lists $4.00 input / $0.20 cached
	// / $5.00 cache write / $15.00 output. This table has no context tiers and
	// usage is summed per turn (the size of each request is lost), so a
	// long-context request is estimated at the short-context rate: a lower bound.
	"openai/gpt-6.1-sol": {
		input: 2,
		output: 10,
		cacheRead: 0.1,
		cacheWrite: 2.5,
	},
};

/**
 * How a route is billed: per token (with a known or unknown price) or by the
 * user's plan. A plan-billed route still carries the model's list price, so
 * its spend can be shown as a labelled list-price estimate (what the same
 * tokens would cost on the API), never as a charge.
 */
export type ModelBilling =
	| { readonly kind: "plan"; readonly price: ModelPrice | null }
	| { readonly kind: "tokens"; readonly price: ModelPrice | null };

function knownPrice(modelId: string) {
	const id = pricedModelId(modelId);
	return (
		KNOWN_MODEL_PRICES[id] ??
		KNOWN_MODEL_PRICES[`openai/${id}`] ??
		KNOWN_MODEL_PRICES[`anthropic/${id}`] ??
		null
	);
}

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
	if (input.harness === "codex")
		return {
			kind: "plan",
			price: input.modelId ? knownPrice(input.modelId) : null,
		};
	if (!input.modelId) return { kind: "tokens", price: null };
	if (/:free$/.test(input.modelId))
		return { kind: "tokens", price: { input: 0, output: 0 } };
	return { kind: "tokens", price: knownPrice(input.modelId) };
}

/**
 * Dollars for one usage record: the provider's reported cost when it gave
 * one, else list price × tokens, null when neither is known. For a
 * plan-billed route this is the list-price estimate (callers label it: the
 * user is not charged per token).
 */
export function usageCostUsd(
	usage: ApiTokenUsage | null | undefined,
	billing: ModelBilling,
): number | null {
	if (!usage) return 0;
	if (billing.kind === "tokens" && typeof usage.costUsd === "number")
		return usage.costUsd;
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
