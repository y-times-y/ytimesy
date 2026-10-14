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
		label: "Claude Sonnet 5.5",
		openRouterId: "anthropic/claude-sonnet-5.5",
		directId: "claude-sonnet-5-5",
	},
	{
		author: "anthropic",
		label: "Claude Haiku 5.5",
		openRouterId: "anthropic/claude-haiku-5.5",
		directId: "claude-haiku-5-5",
	},
	{
		author: "anthropic",
		label: "Claude Fable 5.1",
		openRouterId: "anthropic/claude-fable-5.1",
		directId: "claude-fable-5-1",
	},
	{
		author: "google",
		label: "Gemini 4 Argon",
		openRouterId: "google/gemini-4-argon",
		directId: "gemini-4-argon",
	},
	{
		author: "google",
		label: "Gemini 3.8 Flash",
		openRouterId: "google/gemini-3.8-flash",
		directId: "gemini-3.8-flash",
	},
	{
		author: "google",
		label: "Gemini 3.7 Flash",
		openRouterId: "google/gemini-3.7-flash",
		directId: "gemini-3.7-flash",
	},
	{
		author: "x-ai",
		label: "Grok 4.7",
		openRouterId: "x-ai/grok-4.7",
		directId: "grok-4.7",
	},
	{
		author: "x-ai",
		label: "Grok 4.6",
		openRouterId: "x-ai/grok-4.6",
		directId: "grok-4.6",
	},
	// The makers below are offered through OpenRouter; their direct-key ids are
	// not listed yet, so a direct key for them unlocks nothing until they are.
	{ author: "meta", label: "Muse Wonder", openRouterId: "meta/muse-wonder" },
	{
		author: "meta",
		label: "Muse Spark 1.3",
		openRouterId: "meta/muse-spark-1.3",
	},
	{
		author: "deepseek",
		label: "DeepSeek V4 Pro",
		openRouterId: "deepseek/deepseek-v4-pro-0813",
	},
	{
		author: "deepseek",
		label: "DeepSeek V4.1 Flash",
		openRouterId: "deepseek/deepseek-v4.1-flash",
	},
	{
		author: "z-ai",
		label: "GLM 5.3 Prime",
		openRouterId: "z-ai/glm-5.3-prime",
	},
	{ author: "z-ai", label: "GLM 5.3", openRouterId: "z-ai/glm-5.3" },
	{
		author: "moonshotai",
		label: "Kimi K3",
		openRouterId: "moonshotai/kimi-k3",
	},
	{
		author: "qwen",
		label: "Qwen 3.8 Max",
		openRouterId: "qwen/qwen3.8-max-prime",
	},
];

/** Selector sections in list order. */
export function apiModelSections(): readonly string[] {
	return [...new Set(API_MODEL_LIST.map((model) => model.author))];
}
