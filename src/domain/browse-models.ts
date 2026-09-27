import type { ModelProvider } from "./model-connection";

export type BrowseModel = {
	id: string;
	label: string;
	author: string;
	created: number;
};
const AUTHOR_ORDER = [
	"anthropic",
	"openai",
	"x-ai",
	"google",
	"meta",
	"moonshotai",
	"deepseek",
	"qwen",
	"mistralai",
];
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
};
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
export function parseBrowseModels(value: unknown): BrowseModel[] {
	const rows = (value as { data?: unknown })?.data;
	if (!Array.isArray(rows)) throw new Error("Model catalog unavailable.");
	const models = new Map<string, BrowseModel>();
	for (const row of rows) {
		if (
			!row ||
			typeof row.id !== "string" ||
			typeof row.name !== "string" ||
			row.id.length > 512 ||
			!Array.isArray(row.supported_parameters) ||
			!row.supported_parameters.includes("tools") ||
			!Array.isArray(row.architecture?.output_modalities) ||
			!row.architecture.output_modalities.includes("text") ||
			row.id.endsWith(":batch")
		)
			continue;
		const author = row.id.split("/")[0];
		models.set(row.id, {
			id: row.id,
			label: row.name.replace(/^[^:]+: /, "").slice(0, 160),
			author,
			created: typeof row.created === "number" ? row.created : 0,
		});
	}
	return [...models.values()].sort((a, b) => {
		const rank = (author: string) =>
			AUTHOR_ORDER.includes(author)
				? AUTHOR_ORDER.indexOf(author)
				: AUTHOR_ORDER.length;
		return (
			rank(a.author) - rank(b.author) ||
			a.author.localeCompare(b.author) ||
			b.created - a.created ||
			a.label.localeCompare(b.label)
		);
	});
}
