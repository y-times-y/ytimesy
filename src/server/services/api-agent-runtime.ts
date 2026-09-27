import { isStepCount, type ModelMessage, streamText, type ToolSet } from "ai";
import type { ApiAgentEvent } from "#/domain/api-agent-event";
import { connectedLanguageModel } from "#/server/adapters/api-model";
import { loadModelConnection } from "#/server/adapters/model-connections";
import { modelEndpointTransport } from "#/server/adapters/model-endpoint";
import { connectionApiKey } from "./model-connections";

export type { ApiAgentEvent } from "#/domain/api-agent-event";

/** Run from a durable worker with owner-authorized VM tools. No credentials enter the VM or event stream. */
export async function runApiAgent(input: {
	userId: string;
	connectionId: string;
	connectionRevision?: string;
	maxOutputTokens?: number;
	maxSteps?: number;
	modelId: string;
	messages: ModelMessage[];
	instructions: string;
	tools: ToolSet;
	signal: AbortSignal;
	onEvent: (event: ApiAgentEvent) => Promise<void>;
	onStep: (messages: ModelMessage[]) => Promise<void>;
	beforeStep?: (messages: ModelMessage[]) => Promise<void>;
}): Promise<ModelMessage[]> {
	input.signal.throwIfAborted();
	const connection = await loadModelConnection(
		input.userId,
		input.connectionId,
	);
	if (
		input.connectionRevision &&
		connection?.revision !== input.connectionRevision
	)
		throw new Error(
			"The selected API connection changed. Select it again before retrying.",
		);
	if (
		!connection?.models.some(
			(model) => model.id === input.modelId && model.toolStreamingVerified,
		)
	)
		throw new Error(
			"Select a verified model connection owned by this account.",
		);
	const transport = modelEndpointTransport(connection.baseUrl);
	const cancelled = new AbortController();
	const messages: ModelMessage[] = [];
	try {
		const result = streamText({
			model: connectedLanguageModel(
				{
					...connection,
					modelId: input.modelId,
					apiKey: await connectionApiKey(input.userId, connection),
				},
				transport.fetch,
			),
			messages: input.messages,
			system: input.instructions,
			tools: input.tools,
			prepareStep: async ({ messages }) => {
				await input.beforeStep?.(messages);
			},
			maxRetries: 0,
			streamRetries: 0,
			maxOutputTokens: input.maxOutputTokens ?? 8192,
			stopWhen: isStepCount(input.maxSteps ?? 30),
			// Provider errors can echo request credentials; publish only the sanitized error below.
			onError: () => {},
			abortSignal: AbortSignal.any([
				input.signal,
				cancelled.signal,
				AbortSignal.timeout(30 * 60 * 1000),
			]),
			onStepFinish: async (step) => {
				await input.onStep(step.response.messages);
				messages.push(...step.response.messages);
			},
		});
		for await (const part of result.fullStream) {
			switch (part.type) {
				case "text-delta":
				case "reasoning-delta":
					await input.onEvent({
						type: part.type,
						id: part.id,
						text: part.text,
					});
					break;
				case "tool-call":
					await input.onEvent({
						type: "tool-call",
						id: part.toolCallId,
						name: part.toolName,
						input: part.input,
					});
					break;
				case "tool-result":
					await input.onEvent({
						type: "tool-result",
						id: part.toolCallId,
						name: part.toolName,
						output: part.output,
					});
					break;
				case "error":
					throw new Error(
						"Model request failed. Check connection access and provider credit; no fallback was used.",
					);
				case "abort":
					throw new Error("Model run cancelled.");
			}
		}
		const usage = await result.totalUsage;
		const reason = await result.finishReason;
		await input.onEvent({
			type: "finish",
			inputTokens: usage.inputTokens ?? null,
			outputTokens: usage.outputTokens ?? null,
			reason,
		});
		return messages;
	} finally {
		cancelled.abort();
		await transport.close();
	}
}
