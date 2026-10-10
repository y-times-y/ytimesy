import type { ModelProvider } from "#/domain/model-connection";

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof EFFORT_LEVELS)[number];

/** Unknown levels are ignored rather than guessed; the provider default then applies. */
export function apiReasoningEffort(value: string | undefined) {
	const level = value === "minimal" ? "low" : value;
	return EFFORT_LEVELS.find((candidate) => candidate === level) ?? null;
}

type ProviderOptions = Record<string, Record<string, unknown>>;

/**
 * Without an explicit effort, models run at their own default (Claude Opus 5.5
 * defaults to medium), so a requested level must reach every provider.
 */
export function withReasoningEffort<T extends { providerOptions?: unknown }>(
	settings: T,
	provider: ModelProvider,
	effort: ReasoningEffort | null,
): T {
	if (!effort) return settings;
	const options = (settings.providerOptions ?? {}) as ProviderOptions;
	const merge = (key: string, value: Record<string, unknown>) => ({
		...settings,
		providerOptions: { ...options, [key]: { ...options[key], ...value } },
	});
	switch (provider) {
		case "anthropic":
			return merge("anthropic", { effort });
		case "openrouter":
			// OpenRouter passes Claude effort through unchanged, including "max".
			return merge("openrouter", { reasoning: { effort } });
		case "openai":
			return merge("openai", { reasoningEffort: effort });
		default:
			return settings;
	}
}
