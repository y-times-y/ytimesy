import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ApiTokenUsage } from "../../src/domain/api-token-usage";
import { connectedLanguageModel } from "../../src/server/adapters/api-model";
import { nativeModelCompactor } from "../../src/server/adapters/model-compaction";
import type { ModelAgentRuntime } from "../../src/server/services/model-agent-loop";

export const OPENAI_API_BASE_URL = "https://api.openai.com/v1";

/**
 * Long reasoning steps leave pooled sockets idle long enough to be reset
 * mid-response (observed ETIMEDOUT). Match the subscription transport: never
 * reuse a socket across model requests. This does not retry or replay streams.
 */
function freshConnectionFetch(
	fetch: typeof globalThis.fetch,
): typeof globalThis.fetch {
	return (input, init) => {
		const headers = new Headers(init?.headers);
		headers.set("Connection", "close");
		return fetch(input, { ...init, headers });
	};
}

/**
 * Public OpenAI API counterpart of the tuned subscription runtime: same
 * instructions placement, cache affinity, reasoning summary and parallel tools.
 * Matches the public native Codex run: max effort, standard (non-fast) mode.
 */
export async function openAiSolRuntime(input: {
	modelId: string;
	effort: "high" | "xhigh" | "max";
	cacheScope: string;
	keyFile?: string;
	fetch?: typeof globalThis.fetch;
}): Promise<ModelAgentRuntime> {
	const apiKey = (
		await readFile(input.keyFile ?? ".secrets/openai-api-key", "utf8")
	).trim();
	if (!apiKey.startsWith("sk-")) throw new Error("Expected an OpenAI API key.");
	const model = connectedLanguageModel(
		{
			provider: "openai",
			baseUrl: OPENAI_API_BASE_URL,
			apiKey,
			modelId: input.modelId,
		},
		freshConnectionFetch(input.fetch ?? globalThis.fetch.bind(globalThis)),
	);
	const promptCacheKey = createHash("sha256")
		.update(`ytimesy:evaluation:${input.cacheScope}`)
		.digest("hex");
	const requestSettings = (instructions: string) => ({
		providerOptions: {
			openai: {
				instructions,
				store: false,
				// Stateless requests must carry reasoning forward explicitly.
				include: ["reasoning.encrypted_content"],
				promptCacheKey,
				reasoningEffort: input.effort,
				reasoningSummary: "auto",
				parallelToolCalls: true,
			},
		},
	});
	return {
		model,
		contextWindow: 272_000,
		archiveConsumedGuidance: false,
		prefetchInitialReads: true,
		requestSettings,
		compact: nativeModelCompactor(model, "openai", requestSettings),
	};
}

// Prices inferred exactly from the public native Codex job's per-trial costs;
// cached input is budgeted above the fitted $0.10 so caps stop early, not late.
const SOL_USD_PER_MILLION = { input: 2.5, cachedInput: 0.25, output: 10 };

export function estimatedSolCostUsd(usage: ApiTokenUsage | null) {
	if (!usage) return 0;
	const cached = usage.cacheReadTokens ?? 0;
	const uncached =
		usage.uncachedInputTokens ?? Math.max(0, (usage.inputTokens ?? 0) - cached);
	return (
		(uncached * SOL_USD_PER_MILLION.input +
			cached * SOL_USD_PER_MILLION.cachedInput +
			(usage.outputTokens ?? 0) * SOL_USD_PER_MILLION.output) /
		1_000_000
	);
}
