/**
 * The API models ytimesy offers. This list alone decides what the model
 * selector shows; a provider's own catalog never adds models to it. A key
 * unlocks a maker's section, and an entry appears only when that key can
 * actually use it (so a mistyped or unentitled id stays hidden).
 *
 * `author` is the selector section (keys of AUTHOR_LABELS). `openRouterId` is
 * the id through an OpenRouter key; `directId` is the id through that maker's
 * own key (OpenAI, Anthropic and Google directly, the rest through their
 * fixed OpenAI-compatible endpoint).
 */
export type ListedApiModel = {
	readonly author: string;
	readonly label: string;
	readonly openRouterId: string;
	readonly directId?: string;
};

export const API_MODEL_LIST: readonly ListedApiModel[] = [
	{
		author: "openai",
		label: "GPT-6.1 Sol",
		openRouterId: "openai/gpt-6.1-sol",
		directId: "gpt-6.1-sol",
	},
	{
		author: "openai",
		label: "GPT-6 Sol",
		openRouterId: "openai/gpt-6-sol",
		directId: "gpt-6-sol",
	},
	{
		author: "openai",
		label: "GPT-6 Luna",
		openRouterId: "openai/gpt-6-luna",
		directId: "gpt-6-luna",
	},
	{
		author: "openai",
		label: "GPT-6 Astra",
		openRouterId: "openai/gpt-6-astra",
		directId: "gpt-6-astra",
	},
	{
		author: "anthropic",
		label: "Claude Opus 5.5",
		openRouterId: "anthropic/claude-opus-5.5",
		directId: "claude-opus-5-5",
	},
	{
		author: "anthropic",
		label: "Claude Sonnet 5",
		openRouterId: "anthropic/claude-sonnet-5",
		directId: "claude-sonnet-5",
	},
	{
		author: "anthropic",
		label: "Claude Fable 5.1",
		openRouterId: "anthropic/claude-fable-5.1",
		directId: "claude-fable-5-1",
	},
	{
		author: "google",
		label: "Gemini 3.8 Flash",
		openRouterId: "google/gemini-3.8-flash",
		directId: "gemini-3.8-flash",
	},
	{
		author: "x-ai",
		label: "Grok 4.7",
		openRouterId: "x-ai/grok-4.7",
		directId: "grok-4.7",
	},
];

/** Selector sections in list order. */
export function apiModelSections(): readonly string[] {
	return [...new Set(API_MODEL_LIST.map((model) => model.author))];
}
