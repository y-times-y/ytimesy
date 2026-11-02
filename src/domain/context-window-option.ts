/**
 * A larger context window a route offers beside its standard one: Codex's
 * `max_context_window`, Claude Code's `[1m]` models, a maker's long-context
 * tier. A model without one never shows the option, so it is never offered
 * where it would do nothing.
 */
export type ListedContextWindow = {
	/** The route's default window, in tokens. */
	readonly standard: number;
	/** The larger window the user may choose, in tokens. */
	readonly large: number;
	/** One short line on how the larger window costs more, from the maker's docs. */
	readonly costNote?: string;
};

/** A window as the picker shows it: 272K, 872K, 1M, 1.05M. */
export function contextWindowLabel(tokens: number): string {
	if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(2))}M`;
	return `${Math.round(tokens / 1000)}K`;
}

/** A listed window, kept only when it is real (a larger window than the standard). */
export function listedContextWindow(
	value: unknown,
): ListedContextWindow | undefined {
	if (!value || typeof value !== "object") return undefined;
	const { standard, large, costNote } = value as Record<string, unknown>;
	if (
		typeof standard !== "number" ||
		typeof large !== "number" ||
		!Number.isSafeInteger(standard) ||
		!Number.isSafeInteger(large) ||
		standard <= 0 ||
		large <= standard
	)
		return undefined;
	return {
		standard,
		large,
		...(typeof costNote === "string" && costNote ? { costNote } : {}),
	};
}

/** The window a turn runs with: the larger one only when chosen and offered. */
export function chosenContextWindow(
	option: ListedContextWindow | undefined,
	largeContext: boolean | undefined,
): number | undefined {
	if (!option) return undefined;
	return largeContext ? option.large : option.standard;
}
