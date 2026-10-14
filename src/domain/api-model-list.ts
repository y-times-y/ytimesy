/**
 * The API models ytimesy offers. This list alone decides what the model
 * selector shows; a provider's own catalog never adds models to it. A key
 * unlocks a maker's section, and an entry appears only when that key can
 * actually use it (so a mistyped or unentitled id stays hidden).
 *
 * `author` is the selector section (keys of AUTHOR_LABELS). `openRouterId` is
 * the id through an OpenRouter key; `directId` is the id through that maker's
 * own key (OpenAI, Anthropic and Google directly, the rest through their
 * fixed OpenAI-compatible endpoint). `speeds` are the maker's own faster
 * endpoints, offered through an OpenRouter key only.
 */
export type ApiModelSpeedId = "fast" | "ultrafast";

export type ApiModelSpeed = {
	readonly id: ApiModelSpeedId;
	/** The maker's own tiered OpenRouter endpoints serving this speed. */
	readonly providers: readonly string[];
	/** Price relative to the standard endpoint. */
	readonly priceMultiple: number;
};

export type ListedApiModel = {
	readonly author: string;
	readonly label: string;
	readonly openRouterId: string;
	readonly directId?: string;
	readonly speeds?: readonly ApiModelSpeed[];
};

const OPENAI_FAST: ApiModelSpeed = {
	id: "fast",
	providers: ["openai/fast"],
	priceMultiple: 2,
};
const OPENAI_ULTRAFAST: ApiModelSpeed = {
	id: "ultrafast",
	providers: ["openai/ultrafast"],
	priceMultiple: 6,
};
const GOOGLE_PRIORITY: ApiModelSpeed = {
	id: "fast",
	providers: ["google-ai-studio/priority", "google-vertex/global/priority"],
	priceMultiple: 1.8,
};
const XAI_PRIORITY: ApiModelSpeed = {
	id: "fast",
	providers: ["xai/priority"],
	priceMultiple: 2,
};

export const API_MODEL_LIST: readonly ListedApiModel[] = [
	{
		author: "openai",
		label: "GPT-6.1 Sol",
		openRouterId: "openai/gpt-6.1-sol",
		directId: "gpt-6.1-sol",
		speeds: [OPENAI_FAST, OPENAI_ULTRAFAST],
	},
	{
		author: "openai",
		label: "GPT-6 Luna",
		openRouterId: "openai/gpt-6-luna",
		directId: "gpt-6-luna",
		speeds: [OPENAI_FAST],
	},
	{
		author: "openai",
		label: "GPT-6 Astra",
		openRouterId: "openai/gpt-6-astra",
		directId: "gpt-6-astra",
		speeds: [OPENAI_FAST, OPENAI_ULTRAFAST],
	},
	{
		author: "anthropic",
		label: "Claude Opus 5.5",
		openRouterId: "anthropic/claude-opus-5.5",
		directId: "claude-opus-5-5",
		speeds: [{ id: "fast", providers: ["anthropic/fast"], priceMultiple: 2 }],
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
		speeds: [GOOGLE_PRIORITY],
	},
	{
		author: "google",
		label: "Gemini 3.8 Flash",
		openRouterId: "google/gemini-3.8-flash",
		directId: "gemini-3.8-flash",
		speeds: [GOOGLE_PRIORITY],
	},
	{
		author: "google",
		label: "Gemini 3.7 Flash",
		openRouterId: "google/gemini-3.7-flash",
		directId: "gemini-3.7-flash",
		speeds: [GOOGLE_PRIORITY],
	},
	{
		author: "x-ai",
		label: "Grok 4.7",
		openRouterId: "x-ai/grok-4.7",
		directId: "grok-4.7",
		speeds: [XAI_PRIORITY],
	},
	{
		author: "x-ai",
		label: "Grok 4.6",
		openRouterId: "x-ai/grok-4.6",
		directId: "grok-4.6",
		speeds: [XAI_PRIORITY],
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

/**
 * Each maker's own OpenRouter providers. OpenRouter requests are pinned to
 * these with fallbacks off, so a listed model never runs on a third-party
 * host (or a third party's quantization) even through an OpenRouter key.
 */
const OFFICIAL_OPENROUTER_PROVIDERS: Readonly<
	Record<string, readonly string[]>
> = {
	openai: ["openai"],
	anthropic: ["anthropic"],
	google: ["google-ai-studio", "google-vertex"],
	"x-ai": ["xai"],
	meta: ["meta"],
	deepseek: ["deepseek"],
	"z-ai": ["z-ai"],
	moonshotai: ["moonshotai"],
	qwen: ["alibaba"],
};

/** The faster speeds a listed OpenRouter model offers, empty when none. */
export function apiModelSpeeds(openRouterId: string): readonly ApiModelSpeed[] {
	return (
		API_MODEL_LIST.find((model) => model.openRouterId === openRouterId)
			?.speeds ?? []
	);
}

/**
 * The official providers for a listed OpenRouter model at a speed, or null
 * when the model is not listed or does not offer that speed. Standard speed
 * uses the maker's base providers, which never match a tiered endpoint.
 */
export function officialOpenRouterProviders(
	openRouterId: string,
	speed?: ApiModelSpeedId,
): readonly string[] | null {
	const entry = API_MODEL_LIST.find(
		(model) => model.openRouterId === openRouterId,
	);
	if (!entry) return null;
	if (speed)
		return entry.speeds?.find((tier) => tier.id === speed)?.providers ?? null;
	return OFFICIAL_OPENROUTER_PROVIDERS[entry.author] ?? null;
}
