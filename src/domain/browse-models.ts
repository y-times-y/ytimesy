import type { ModelProvider } from "./model-connection";

export type BrowseModel = {
	id: string;
	label: string;
	author: string;
	created: number;
};
export const AUTHOR_LABELS: Record<string, string> = {
	anthropic: "Anthropic",
	openai: "OpenAI",
	"x-ai": "xAI",
	google: "Google",
	meta: "Meta",
	moonshotai: "Moonshot AI",
	deepseek: "DeepSeek",
	qwen: "Qwen",
	mistralai: "Mistral",
	"z-ai": "Z.ai",
	minimax: "MiniMax",
	xiaomi: "Xiaomi",
	tencent: "Tencent",
	nvidia: "NVIDIA",
};
const MAX_MODEL_AGE_SECONDS = 365 * 24 * 60 * 60;

export function matchesModelSearch(
	model: Pick<BrowseModel, "label" | "author">,
	search: string,
): boolean {
	const term = search.trim().toLowerCase();
	return (
		!term ||
		model.label.toLowerCase().includes(term) ||
		model.author.toLowerCase().includes(term) ||
		(AUTHOR_LABELS[model.author] ?? "").toLowerCase().includes(term)
	);
}
export const DIRECT_MODEL_ENDPOINTS: Record<string, string> = {
	meta: "https://api.meta.ai/v1",
	deepseek: "https://api.deepseek.com",
	"x-ai": "https://api.x.ai/v1",
	mistralai: "https://api.mistral.ai/v1",
};
export function directModelProvider(author: string): ModelProvider | null {
	if (Object.hasOwn(DIRECT_MODEL_ENDPOINTS, author)) return "compatible";
	return author === "openai" || author === "anthropic" || author === "google"
		? author
		: null;
}
export function openRouterModelLabel(name: string): string {
	return name.replace(/^[^:]+: /, "");
}
export function isNonCodingModelId(id: string): boolean {
	return /(?:audio|embedding|image|realtime|search|transcri|tts|safeguard|guard|moderation|classifier|rerank)/i.test(
		id,
	);
}
export function isOpenRouterCodingModel(row: unknown): row is {
	id: string;
	name: string;
	created?: number;
} {
	if (!row || typeof row !== "object") return false;
	const model = row as Record<string, unknown>;
	const architecture = model.architecture as
		| { output_modalities?: unknown }
		| undefined;
	return (
		typeof model.id === "string" &&
		typeof model.name === "string" &&
		model.id.length <= 512 &&
		!model.id.endsWith(":batch") &&
		!model.id.startsWith("~") &&
		!isNonCodingModelId(model.id) &&
		Array.isArray(model.supported_parameters) &&
		model.supported_parameters.includes("tools") &&
		Array.isArray(architecture?.output_modalities) &&
		architecture.output_modalities.length === 1 &&
		architecture.output_modalities[0] === "text"
	);
}
export function parseBrowseModels(
	value: unknown,
	nowSeconds = Math.floor(Date.now() / 1000),
): BrowseModel[] {
	const rows = (value as { data?: unknown })?.data;
	if (!Array.isArray(rows)) throw new Error("Model catalog unavailable.");
	const models = new Map<string, BrowseModel>();
	for (const row of rows) {
		if (!isOpenRouterCodingModel(row)) continue;
		const created = typeof row.created === "number" ? row.created : 0;
		if (created < nowSeconds - MAX_MODEL_AGE_SECONDS) continue;
		const author = row.id.split("/")[0];
		models.set(row.id, {
			id: row.id,
			label: openRouterModelLabel(row.name).slice(0, 160),
			author,
			created,
		});
	}
	return [...models.values()];
}
