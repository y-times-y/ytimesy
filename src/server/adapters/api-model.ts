import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { ModelProvider } from "#/domain/model-connection";
import { openRouterCacheFetch } from "./api-prompt-cache";

export function connectedLanguageModel(
	input: {
		provider: ModelProvider;
		baseUrl: string;
		apiKey: string;
		modelId: string;
	},
	fetch: typeof globalThis.fetch,
): LanguageModel {
	const options = { apiKey: input.apiKey, baseURL: input.baseUrl, fetch };
	switch (input.provider) {
		case "openai":
			return createOpenAI(options).responses(input.modelId);
		case "anthropic":
			return createAnthropic(options)(input.modelId);
		case "google":
			return createGoogleGenerativeAI(options)(input.modelId);
		case "openrouter":
			return createOpenAICompatible({
				...options,
				name: input.provider,
				includeUsage: true,
				fetch:
					new URL(input.baseUrl).hostname === "openrouter.ai"
						? openRouterCacheFetch(fetch)
						: fetch,
			})(input.modelId);
		case "compatible":
			return createOpenAICompatible({ ...options, name: input.provider })(
				input.modelId,
			);
	}
}
