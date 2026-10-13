import type { ModelProvider } from "#/domain/model-connection";
import { browseModels } from "./browse-models";
import { readModelCatalogBody } from "./model-catalog";

type ModelContext = {
	contextWindow?: number;
	nativeCompaction?: "openai" | "openai-endpoint" | "anthropic" | "xai";
};
const cached = new Map<string, { expires: number; value: ModelContext }>();
const positiveInteger = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? value
		: undefined;

/** Public catalog limits or owner-authenticated metadata only; never starts inference. */
export async function readModelContext(
	input: {
		provider: ModelProvider;
		baseUrl: string;
		apiKey: string;
		modelId: string;
		contextWindow?: number;
		cacheKey: string;
	},
	fetch: typeof globalThis.fetch,
): Promise<ModelContext> {
	const saved = cached.get(input.cacheKey);
	if (saved && saved.expires > Date.now()) return saved.value;
	let contextWindow = input.contextWindow;
	const origin = new URL(input.baseUrl).origin;
	let nativeCompaction: ModelContext["nativeCompaction"] =
		input.provider === "openai" &&
		origin === "https://api.openai.com" &&
		/^gpt-6(?:[.-]|$)/.test(input.modelId)
			? "openai"
			: undefined;
	if (
		input.provider === "openai" &&
		origin === "https://api.openai.com" &&
		/^gpt-5\.[2-6](?:[.-]|$)/.test(input.modelId)
	)
		nativeCompaction = "openai-endpoint";
	if (
		input.provider === "compatible" &&
		origin === "https://api.x.ai" &&
		/^grok-4\.7(?:-|$)/.test(input.modelId)
	)
		nativeCompaction = "xai";
	try {
		if (
			(input.provider === "google" &&
				origin === "https://generativelanguage.googleapis.com") ||
			(input.provider === "anthropic" && origin === "https://api.anthropic.com")
		) {
			const response = await fetch(
				`${input.baseUrl}/models/${encodeURIComponent(input.modelId)}`,
				{
					headers:
						input.provider === "google"
							? { "x-goog-api-key": input.apiKey }
							: {
									"x-api-key": input.apiKey,
									"anthropic-version": "2023-06-01",
									"anthropic-beta": "compact-2026-09-04",
								},
					signal: AbortSignal.timeout(3000),
					redirect: "manual",
				},
			);
			if (response.ok) {
				const row = await readModelCatalogBody(response);
				contextWindow =
					positiveInteger(row.inputTokenLimit ?? row.max_input_tokens) ??
					contextWindow;
				if (
					input.provider === "anthropic" &&
					row.capabilities?.compaction?.supported === true
				)
					nativeCompaction = "anthropic";
			}
		} else if (input.provider === "openrouter" || input.provider === "openai") {
			const catalogId =
				input.provider === "openai" ? `openai/${input.modelId}` : input.modelId;
			contextWindow ??= (await browseModels()).find(
				(row) => row.id === catalogId,
			)?.contextWindow;
		}
	} catch {
		// Missing metadata uses the conservative shared budget, not an invented model limit.
	}
	const value = { contextWindow, nativeCompaction };
	if (cached.size >= 1000) cached.delete(cached.keys().next().value as string);
	cached.set(input.cacheKey, {
		value,
		expires: Date.now() + (contextWindow ? 15 * 60_000 : 30_000),
	});
	return value;
}
