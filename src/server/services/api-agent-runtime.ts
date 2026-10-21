import type { LanguageModel, ModelMessage } from "ai";
import type { ApiModelSpeedId } from "#/domain/api-model-list";
import { defaultMaxOutputTokens } from "#/domain/api-output-limit";
import { ApiModelPreparationFailure } from "#/domain/api-turn-failure";
import { type ModelProvider, modelRouteId } from "#/domain/model-connection";
import { connectedLanguageModel } from "#/server/adapters/api-model";
import { apiPromptCacheSettings } from "#/server/adapters/api-prompt-cache";
import {
	nativeModelCompactor,
	responsesEndpointCompactor,
} from "#/server/adapters/model-compaction";
import { loadModelConnection } from "#/server/adapters/model-connections";
import { readModelContext } from "#/server/adapters/model-context";
import { modelEndpointTransport } from "#/server/adapters/model-endpoint";
import {
	apiReasoningEffort,
	withReasoningEffort,
} from "../adapters/api-reasoning-effort";
import {
	type ModelAgentInput,
	type ModelAgentRuntime,
	runModelAgent,
	runModelAgentStep,
} from "./model-agent-loop";
import { availableApiModelRoutes, connectionApiKey } from "./model-connections";

export type { ApiAgentEvent, ModelAgentInput } from "./model-agent-loop";
export { runModelAgent } from "./model-agent-loop";

export async function runApiAgent(
	input: ModelAgentInput & { connectionId: string },
): Promise<ModelMessage[]> {
	return withApiModel(input, (runtime) => runModelAgent(input, runtime));
}

export function runApiAgentStep(
	input: ModelAgentInput & { connectionId: string },
) {
	return withApiModel(input, (runtime) => runModelAgentStep(input, runtime));
}

/** What preparing an API connection's model reads from a run's input. */
type ApiModelInput = Pick<
	ModelAgentInput,
	| "userId"
	| "connectionRevision"
	| "modelId"
	| "speed"
	| "cacheScopeId"
	| "reasoning"
	| "maxOutputTokens"
	| "signal"
> & { connectionId: string };

/** Runs `run` with an API connection's model prepared (also for one-off calls such as the sidekick classifier). */
export async function withApiModel<T>(
	input: ApiModelInput,
	run: (runtime: ModelAgentRuntime) => Promise<T>,
): Promise<T> {
	let stage: string = "connection";
	try {
		return await prepareApiModel(input, run, (next) => {
			stage = next;
		});
	} catch (error) {
		if (stage === "inference" || !(error instanceof TypeError)) throw error;
		throw new ApiModelPreparationFailure(stage);
	}
}

async function prepareApiModel<T>(
	input: ApiModelInput,
	run: (runtime: ModelAgentRuntime) => Promise<T>,
	onStage: (stage: string) => void,
): Promise<T> {
	input.signal.throwIfAborted();
	const connection = await loadModelConnection(
		input.userId,
		input.connectionId,
	);
	onStage("catalog");
	if (
		input.connectionRevision &&
		connection?.revision !== input.connectionRevision
	)
		throw new Error(
			"The selected API connection changed. Select it again before retrying.",
		);
	if (
		!connection ||
		!(await availableApiModelRoutes([connection])).some(
			(model) => model.id === modelRouteId(connection.id, input.modelId),
		)
	)
		throw new Error(
			"The selected model is no longer available on this connection.",
		);
	onStage("transport");
	const transport = modelEndpointTransport(connection.baseUrl);
	try {
		onStage("credential");
		const apiKey = await connectionApiKey(input.userId, connection);
		return await run(
			await apiModelRuntime(
				{
					provider: connection.provider,
					baseUrl: connection.baseUrl,
					apiKey,
					modelId: input.modelId,
					speed: input.speed,
					userId: input.userId,
					connectionId: input.connectionId,
					cacheScopeId: input.cacheScopeId ?? "default",
					contextCacheKey: JSON.stringify([
						input.userId,
						connection.id,
						connection.revision,
						input.modelId,
					]),
					contextWindow: connection.models.find(
						(row) => row.id === input.modelId,
					)?.contextWindow,
					reasoning: input.reasoning,
					maxOutputTokens: input.maxOutputTokens,
					fetch: transport.fetch,
				},
				onStage,
			),
		);
	} finally {
		await transport.close();
	}
}

/**
 * The model runtime of an API route, from the route's endpoint and key: the
 * request settings, prompt-cache routing, reasoning effort, context window
 * and native compaction every API-harness turn uses. prepareApiModel calls
 * it for a stored connection; the Harbor bridge (evals/harbor_v2) calls it
 * with a key file, so both run the same runtime.
 */
export async function apiModelRuntime(
	input: {
		provider: ModelProvider;
		baseUrl: string;
		apiKey: string;
		modelId: string;
		speed?: ApiModelSpeedId;
		userId: string;
		connectionId: string;
		cacheScopeId: string;
		/** Caches the model's catalog limits; a stored connection adds its revision. */
		contextCacheKey: string;
		/** The connection's own catalog row, when it lists one. */
		contextWindow?: number;
		reasoning?: string;
		maxOutputTokens?: number;
		fetch: typeof globalThis.fetch;
		/**
		 * Wraps the model before anything uses it (an evaluation's spending
		 * guard), so native compaction's requests go through the wrapper too.
		 */
		wrapModel?: (model: LanguageModel) => LanguageModel;
	},
	onStage: (stage: string) => void = () => {},
): Promise<ModelAgentRuntime> {
	onStage("model");
	const connected = connectedLanguageModel(input, input.fetch);
	const model = input.wrapModel ? input.wrapModel(connected) : connected;
	const cacheSettings = apiPromptCacheSettings({
		provider: input.provider,
		baseUrl: input.baseUrl,
		userId: input.userId,
		connectionId: input.connectionId,
		scopeId: input.cacheScopeId,
	});
	const origin = new URL(input.baseUrl).origin;
	const responsesRoute =
		input.provider === "openai" ||
		(input.provider === "compatible" &&
			["https://api.x.ai", "https://api.meta.ai"].includes(origin));
	const boundPrefix =
		input.provider === "anthropic" ||
		input.provider === "google" ||
		(input.provider === "openrouter" &&
			/^(anthropic|google)\//.test(input.modelId));
	onStage("context");
	const context = await readModelContext(
		{
			provider: input.provider,
			baseUrl: input.baseUrl,
			apiKey: input.apiKey,
			modelId: input.modelId,
			contextWindow: input.contextWindow,
			cacheKey: input.contextCacheKey,
		},
		input.fetch,
	);
	const effort = apiReasoningEffort(input.reasoning);
	const baseRequestSettings = (instructions: string) =>
		responsesRoute
			? {
					...cacheSettings,
					providerOptions: {
						...cacheSettings.providerOptions,
						openai: {
							...cacheSettings.providerOptions?.openai,
							instructions,
							store: false,
							include: ["reasoning.encrypted_content"],
						},
					},
				}
			: {
					...cacheSettings,
					system: instructions,
					...(context.nativeCompaction === "anthropic" &&
					origin === "https://api.anthropic.com"
						? {
								providerOptions: {
									...cacheSettings.providerOptions,
									anthropic: {
										...cacheSettings.providerOptions?.anthropic,
										thinking: {
											blockBinding: { prefixMismatchBehavior: "error" },
										},
									},
								},
							}
						: {}),
				};
	const requestSettings = (instructions: string) =>
		withReasoningEffort(
			baseRequestSettings(instructions),
			input.provider,
			effort,
		);
	onStage("inference");
	return {
		model,
		cacheSettings,
		maxOutputTokens:
			input.maxOutputTokens ??
			defaultMaxOutputTokens(input.provider, input.modelId),
		contextWindow: context.contextWindow,
		imageInput: context.imageInput,
		fallbackContextPolicy: boundPrefix ? "bound-prefix" : "whole-turns",
		backgroundCompaction: input.provider === "openai",
		requestSettings,
		compact:
			context.nativeCompaction === "xai" ||
			context.nativeCompaction === "openai-endpoint"
				? responsesEndpointCompactor(input)
				: context.nativeCompaction
					? nativeModelCompactor(
							model,
							context.nativeCompaction,
							requestSettings,
						)
					: undefined,
	};
}
