import { contextWindowLabel } from "#/domain/context-window-option";
import { knownModelLimits } from "#/domain/model-context-windows";
import { modelPrice } from "#/domain/model-pricing";
import type { ReasoningLevel } from "./model-capabilities";

/** Shown instead of a price for models billed by the user's plan. */
export const INCLUDED_IN_PLAN = "Included in plan";

/** A per-million-token price: whole dollars bare ($4), otherwise at least cents ($0.10, $0.075). */
export function formatUsdPerMillion(value: number): string {
	if (!Number.isFinite(value) || value < 0) return "";
	if (Number.isInteger(value)) return `$${value}`;
	return `$${value.toFixed(3).replace(/0$/, "")}`;
}

export type ModelPriceDisplay =
	| { readonly kind: "plan" }
	| {
			readonly kind: "price";
			readonly input: string;
			readonly output: string;
			/** "$in / $out" for a row. */
			readonly short: string;
			/** Spoken form for screen readers. */
			readonly spoken: string;
	  };

/**
 * What a row and its detail card show for a model's price, from the
 * checked-in list prices only. Null when the model has no known price: the
 * field is then left out, never guessed.
 */
export function modelPriceDisplay(
	modelId: string,
	plan: boolean,
): ModelPriceDisplay | null {
	if (plan) return { kind: "plan" };
	const price = modelPrice(modelId);
	if (!price) return null;
	const input = formatUsdPerMillion(price.input);
	const output = formatUsdPerMillion(price.output);
	if (!input || !output) return null;
	return {
		kind: "price",
		input,
		output,
		short: `${input} / ${output}`,
		spoken: `${input} input and ${output} output per million tokens`,
	};
}

/** The context window to show: a listed one first, then the checked-in limits; null when unknown. */
export function modelContextLabel(
	modelId: string,
	listedTokens?: number | null,
): string | null {
	const tokens = listedTokens ?? knownModelLimits(modelId)?.contextWindow;
	return tokens && tokens > 0 ? contextWindowLabel(tokens) : null;
}

/** The level a slider key lands on, or null when the key does not move it. */
export function reasoningStepTarget(
	levels: readonly ReasoningLevel[],
	currentId: string,
	key: string,
): string | null {
	if (!levels.length) return null;
	const index = Math.max(
		0,
		levels.findIndex((level) => level.id === currentId),
	);
	let next = index;
	if (key === "ArrowRight" || key === "ArrowUp") next = index + 1;
	else if (key === "ArrowLeft" || key === "ArrowDown") next = index - 1;
	else if (key === "Home") next = 0;
	else if (key === "End") next = levels.length - 1;
	else return null;
	next = Math.min(levels.length - 1, Math.max(0, next));
	return next === index ? null : (levels[next]?.id ?? null);
}

/** Where arrow keys move focus in a list of `count` options; null when they do not move it. */
export function nextFocusIndex(
	current: number,
	count: number,
	key: string,
): number | null {
	if (!count) return null;
	if (key === "ArrowDown") return Math.min(count - 1, current + 1);
	if (key === "ArrowUp") return Math.max(0, current - 1);
	if (key === "Home") return 0;
	if (key === "End") return count - 1;
	return null;
}
