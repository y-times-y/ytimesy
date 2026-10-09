import type { ModelMessage } from "ai";
import { ApiModelPreparationFailure } from "#/domain/api-turn-failure";
import { modelRouteId } from "#/domain/model-connection";
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

async function withApiModel<T>(
	input: ModelAgentInput & { connectionId: string },
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
	input: ModelAgentInput & { connectionId: string },
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
		onStage("model");
		const model = connectedLanguageModel(
			{
				...connection,
				modelId: input.modelId,
				apiKey,
			},
			transport.fetch,
		);
		const cacheSettings = apiPromptCacheSettings({
			...connection,
			userId: input.userId,
			connectionId: input.connectionId,
			scopeId: input.cacheScopeId ?? "default",
		});
		const origin = new URL(connection.baseUrl).origin;
		const responsesRoute =
			connection.provider === "openai" ||
			(connection.provider === "compatible" &&
				["https://api.x.ai", "https://api.meta.ai"].includes(origin));
		const boundPrefix =
			connection.provider === "anthropic" ||
			connection.provider === "google" ||
			(connection.provider === "openrouter" &&
				/^(anthropic|google)\//.test(input.modelId));
		onStage("context");
		const context = await readModelContext(
			{
				...connection,
				apiKey,
				modelId: input.modelId,
				contextWindow: connection.models.find((row) => row.id === input.modelId)
					?.contextWindow,
				cacheKey: JSON.stringify([
					input.userId,
					connection.id,
					connection.revision,
					input.modelId,
				]),
			},
			transport.fetch,
		);
		const requestSettings = (instructions: string) =>
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
		onStage("inference");
		return await run({
			model,
			cacheSettings,
			maxOutputTokens: input.maxOutputTokens ?? 8192,
			contextWindow: context.contextWindow,
			fallbackContextPolicy: boundPrefix ? "bound-prefix" : "whole-turns",
			backgroundCompaction: connection.provider === "openai",
			// Enable retirement only for the known unbound OpenAI reasoning contract.
			// Unknown compatible routes and prefix-bound providers retain observations.
			archiveConsumedGuidance:
				connection.provider === "openai" ||
				(connection.provider === "openrouter" &&
					/^openai\//.test(input.modelId)),
			requestSettings,
			compact:
				context.nativeCompaction === "xai" ||
				context.nativeCompaction === "openai-endpoint"
					? responsesEndpointCompactor({
							...connection,
							modelId: input.modelId,
							apiKey,
							fetch: transport.fetch,
						})
					: context.nativeCompaction
						? nativeModelCompactor(
								model,
								context.nativeCompaction,
								requestSettings,
							)
						: undefined,
		});
	} finally {
		await transport.close();
	}
}
