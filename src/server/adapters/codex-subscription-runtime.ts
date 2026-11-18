import { APICallError } from "ai";
import {
	SubscriptionUsageLimitReached,
	usageLimitReset,
} from "#/domain/api-turn-failure";
import {
	type CatalogRow,
	codexTurnContext,
	FAST_SERVICE_TIER,
} from "#/domain/codex-catalog";
import { connectedLanguageModel } from "./api-model";
import { nativeModelCompactor } from "./model-compaction";

/**
 * The part of a Codex subscription turn's model that holds no credential and
 * reads no database, so the Durable Object (which sends the request itself)
 * and a turn runner box (which sends it through the edge's model proxy) build
 * the very same runtime (docs/turn-runner-boxes.md, "Subscription routes").
 */
export const CODEX_BACKEND = "https://chatgpt.com/backend-api";

/** What the account's catalog and token decide for one turn. */
export type CodexSelection = {
	readonly selected: CatalogRow;
	readonly effort: string;
	/** Prompt-cache routing (the `session-id` header and `promptCacheKey`). */
	readonly cacheKey: string;
};

/** The same answer checks on a model response, wherever the request went. */
export async function guardCodexInference(
	url: RequestInfo | URL,
	response: Response,
): Promise<Response> {
	// A spent plan allowance answers 429 like a rate limit, but retrying cannot help.
	if (response.status === 429) {
		const limit = usageLimitReset(await response.clone().text());
		if (limit !== undefined) {
			await response.body?.cancel();
			throw new SubscriptionUsageLimitReached(limit);
		}
	}
	// rl-tests-sol: a 200 with no body ("Failed to process successful
	// response", the SDK's EmptyResponseBodyError) failed the turn. Nothing
	// was streamed or executed, so this is a request-start failure the
	// SDK's bounded retry may resend; any stream that started is never
	// replayed.
	if (response.ok && !response.body)
		throw new APICallError({
			message: "The provider accepted the request but sent no response body.",
			url: String(url),
			requestBodyValues: {},
			statusCode: response.status,
			isRetryable: true,
		});
	return response;
}

export function codexSubscriptionRuntime(input: {
	readonly modelId: string;
	readonly selection: CodexSelection;
	readonly fast: boolean;
	readonly alternateContext: boolean;
	readonly baseUrl: string;
	readonly apiKey: string;
	readonly transport: typeof fetch;
}) {
	const { selected, effort, cacheKey } = input.selection;
	const model = connectedLanguageModel(
		{
			provider: "openai",
			baseUrl: input.baseUrl,
			modelId: input.modelId,
			apiKey: input.apiKey,
		},
		input.transport,
	);
	const requestSettings = (instructions: string) => ({
		providerOptions: {
			openai: {
				instructions,
				store: false,
				promptCacheKey: cacheKey,
				reasoningEffort: effort,
				reasoningSummary: "auto",
				...(input.fast ? { serviceTier: FAST_SERVICE_TIER } : {}),
				// Independent tool calls may share a response. Authorization and
				// write/lease fencing remain enforced by each tool's executor.
				parallelToolCalls: true,
			},
		},
	});
	return {
		model,
		...codexTurnContext(selected, input.alternateContext),
		// Initial reads use a stable preflight prefix; complete current bodies and
		// hashed read receipts prevent a second mandatory-guidance fetch.
		prefetchInitialReads: true,
		// The backend refuses unstreamed requests; the harness's own summary
		// (its fallback when it declines a native compaction) streams.
		streamOnly: true,
		requestSettings,
		compact: nativeModelCompactor(model, "openai", requestSettings),
	};
}
