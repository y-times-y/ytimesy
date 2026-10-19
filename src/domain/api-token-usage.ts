export type ApiTokenUsage = {
	inputTokens: number | null;
	outputTokens: number | null;
	uncachedInputTokens: number | null;
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
	/**
	 * Dollars the provider itself reported (OpenRouter returns a cost per
	 * request). Absent when no request reported one; null when only some did.
	 */
	costUsd?: number | null;
};

const TOKEN_FIELDS = [
	"inputTokens",
	"outputTokens",
	"uncachedInputTokens",
	"cacheReadTokens",
	"cacheWriteTokens",
] as const;

export function addApiTokenUsage(
	previous: ApiTokenUsage | null,
	next: ApiTokenUsage,
): ApiTokenUsage {
	if (!previous) return next;
	const sum = Object.fromEntries(
		TOKEN_FIELDS.map((key) => [
			key,
			previous[key] === null || next[key] === null
				? null
				: previous[key] + next[key],
		]),
	) as ApiTokenUsage;
	if (previous.costUsd === undefined && next.costUsd === undefined) return sum;
	return {
		...sum,
		costUsd:
			typeof previous.costUsd === "number" && typeof next.costUsd === "number"
				? previous.costUsd + next.costUsd
				: null,
	};
}
