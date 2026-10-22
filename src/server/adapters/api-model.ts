import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import type { ApiModelSpeedId } from "#/domain/api-model-list";
import type { ModelProvider } from "#/domain/model-connection";
import { timedModelFetch } from "../services/turn-timing";
import { openRouterCacheFetch } from "./api-prompt-cache";
import { openRouterOfficialFetch } from "./openrouter-official";
import {
	openRouterReasoningFetch,
	withOpenRouterReasoning,
} from "./openrouter-reasoning";
import { preservedThinkingFetch } from "./preserved-thinking";

export function connectedLanguageModel(
	input: {
		provider: ModelProvider;
		baseUrl: string;
		apiKey: string;
		modelId: string;
		/** Faster maker endpoints; only OpenRouter keys reach them. */
		speed?: ApiModelSpeedId;
	},
	transport: typeof globalThis.fetch,
): LanguageModel {
	// A durable step's line separates network time from model time.
	const fetch = timedModelFetch(transport);
	const options = { apiKey: input.apiKey, baseURL: input.baseUrl, fetch };
	switch (input.provider) {
		case "openai":
			return createOpenAI(options).responses(input.modelId);
		case "anthropic":
			return createAnthropic(options)(input.modelId);
		case "google":
			return createGoogleGenerativeAI(options)(input.modelId);
		case "openrouter":
			return withOpenRouterReasoning(
				createOpenRouter({
					...options,
					fetch: openRouterReasoningFetch(
						openRouterOfficialFetch(
							new URL(input.baseUrl).hostname === "openrouter.ai"
								? openRouterCacheFetch(fetch)
								: fetch,
							input.speed,
						),
					),
				})(input.modelId),
			);
		case "compatible":
			if (
				["https://api.x.ai", "https://api.meta.ai"].includes(
					new URL(input.baseUrl).origin,
				)
			)
				return createOpenAI(options).responses(input.modelId);
			if (new URL(input.baseUrl).origin === "https://api.deepseek.com")
				return createDeepSeek(options)(input.modelId);
			return createOpenAICompatible({
				...options,
				name: input.provider,
				fetch: preservedThinkingFetch(input.baseUrl, fetch),
			})(input.modelId);
	}
}
