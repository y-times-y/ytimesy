import { readFile } from "node:fs/promises";
import type { ApiTokenUsage } from "../../src/domain/api-token-usage";
import { connectedLanguageModel } from "../../src/server/adapters/api-model";
import {
	type ReasoningEffort,
	withReasoningEffort,
} from "../../src/server/adapters/api-reasoning-effort";
import type { ModelAgentRuntime } from "../../src/server/services/model-agent-loop";

/** Claude in Amazon Bedrock: Messages API shape; bearer tokens travel as x-api-key. */
export const BEDROCK_MANTLE_BASE_URL =
	"https://bedrock-mantle.us-east-1.api.aws/anthropic/v1";

/** Matches the public Opus 5.5 + Claude Code entry: max effort, standard speed. */
export async function bedrockClaudeRuntime(input: {
	modelId: string;
	effort: ReasoningEffort;
	keyFile?: string;
	fetch?: typeof globalThis.fetch;
}): Promise<ModelAgentRuntime> {
	const apiKey = (
		await readFile(input.keyFile ?? ".secrets/bedrock-api-key", "utf8")
	).trim();
	if (!apiKey.startsWith("bedrock-api-key-"))
		throw new Error("Expected a Bedrock API key.");
	const model = connectedLanguageModel(
		{
			provider: "anthropic",
			baseUrl: BEDROCK_MANTLE_BASE_URL,
			apiKey,
			modelId: input.modelId,
		},
		input.fetch ?? globalThis.fetch.bind(globalThis),
	);
	const cacheSettings = {
		providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
	};
	return {
		model,
		cacheSettings,
		// Max effort thinks at length; a small output cap would truncate it.
		maxOutputTokens: 64_000,
		contextWindow: 1_000_000,
		fallbackContextPolicy: "bound-prefix",
		archiveConsumedGuidance: false,
		requestSettings: (instructions) =>
			withReasoningEffort(
				{ ...cacheSettings, system: instructions },
				"anthropic",
				input.effort,
			),
	};
}

// List prices per million tokens; cache rates are deliberately conservative so a
// spending cap stops early rather than late.
const OPUS_5_5_USD_PER_MILLION = {
	input: 4,
	output: 20,
	cacheRead: 0.4,
	cacheWrite: 5,
};

export function estimatedOpusCostUsd(usage: ApiTokenUsage | null) {
	if (!usage) return 0;
	const uncached =
		usage.uncachedInputTokens ??
		Math.max(0, (usage.inputTokens ?? 0) - (usage.cacheReadTokens ?? 0));
	return (
		(uncached * OPUS_5_5_USD_PER_MILLION.input +
			(usage.cacheWriteTokens ?? 0) * OPUS_5_5_USD_PER_MILLION.cacheWrite +
			(usage.cacheReadTokens ?? 0) * OPUS_5_5_USD_PER_MILLION.cacheRead +
			(usage.outputTokens ?? 0) * OPUS_5_5_USD_PER_MILLION.output) /
		1_000_000
	);
}
