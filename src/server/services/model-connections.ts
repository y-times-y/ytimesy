import { randomUUID } from "node:crypto";
import { streamText, tool } from "ai";
import { Effect } from "effect";
import { z } from "zod";
import {
	availableConnectionModels,
	modelConnectionInput,
	modelRouteId,
	type PublicModelConnection,
} from "#/domain/model-connection";
import { connectedLanguageModel } from "#/server/adapters/api-model";
import { browseModels } from "#/server/adapters/browse-models";
import { discoverConnectionModels } from "#/server/adapters/model-catalog";
import {
	claimModelProbe,
	loadModelConnection,
	markModelVerified,
	type StoredModelConnection,
	saveModelConnection,
} from "#/server/adapters/model-connections";
import { modelEndpointTransport } from "#/server/adapters/model-endpoint";
import { devAllowsAnyModel } from "#/server/adapters/openrouter-official";
import { seal, unseal } from "#/server/auth/token-vault";

export async function availableApiModelRoutes(
	connections: readonly PublicModelConnection[],
) {
	const hasGateway = connections.some((row) => row.provider === "openrouter");
	const routes = availableConnectionModels(
		connections,
		hasGateway ? await browseModels() : [],
	);
	// Development only: offer every model a connection lists (e.g. free test models).
	return devAllowsAnyModel()
		? withEveryConnectedModel(routes, connections)
		: routes;
}

function withEveryConnectedModel(
	routes: ReturnType<typeof availableConnectionModels>,
	connections: readonly PublicModelConnection[],
) {
	const known = new Set(routes.map((route) => route.id));
	const extra = connections.flatMap((connection) =>
		connection.models
			.map((model) => ({
				id: modelRouteId(connection.id, model.id),
				label: `${model.label} · ${connection.label}`,
			}))
			.filter((route) => !known.has(route.id)),
	);
	return [...routes, ...extra];
}

export function connectApiModels(userId: string, raw: unknown) {
	return Effect.tryPromise(async () => {
		const input = modelConnectionInput.parse(raw);
		if (input.id && !(await loadModelConnection(userId, input.id)))
			throw new Error("Connection not available.");
		const id = input.id ?? randomUUID();
		const transport = modelEndpointTransport(input.baseUrl);
		try {
			const models = await discoverConnectionModels(input, transport.fetch);
			if (!models.length) throw new Error("This provider returned no models.");
			await saveModelConnection(
				userId,
				{
					id,
					provider: input.provider,
					label: input.label,
					baseUrl: input.baseUrl,
					models,
					sealedCredential: await seal(
						JSON.stringify({ id, userId, apiKey: input.apiKey }),
						{ purpose: "model-credential", userId },
					),
				},
				Boolean(input.id),
			);
		} finally {
			await transport.close();
		}
	});
}

export async function connectionApiKey(
	userId: string,
	connection: StoredModelConnection,
): Promise<string> {
	const value = z
		.object({ id: z.string(), userId: z.string(), apiKey: z.string().min(8) })
		.parse(
			JSON.parse(
				await unseal(connection.sealedCredential, {
					purpose: "model-credential",
					userId,
				}),
			),
		);
	if (value.id !== connection.id || value.userId !== userId)
		throw new Error("Connection credential ownership mismatch.");
	return value.apiKey;
}

/** An explicit, bounded billable probe. Never executes shell commands or falls back to another credential. */
export function verifyApiModel(
	userId: string,
	connectionId: string,
	modelId: string,
) {
	return Effect.tryPromise(async () => {
		const connection = await loadModelConnection(userId, connectionId);
		if (!connection?.models.some((model) => model.id === modelId))
			throw new Error("Model not available.");
		if (!(await claimModelProbe(userId, connectionId, connection.revision)))
			throw new Error("Wait before retrying model verification.");
		const transport = modelEndpointTransport(connection.baseUrl);
		try {
			const model = connectedLanguageModel(
				{
					...connection,
					apiKey: await connectionApiKey(userId, connection),
					modelId,
				},
				transport.fetch,
			);
			const result = streamText({
				model,
				maxRetries: 0,
				streamRetries: 0,
				maxOutputTokens: 256,
				abortSignal: AbortSignal.timeout(30_000),
				onError: () => {},
				prompt:
					"Call connection_check with value ok. Do not perform any other action.",
				toolChoice: { type: "tool", toolName: "connection_check" },
				tools: {
					connection_check: tool({
						description: "Validate a connection; no side effects.",
						inputSchema: z.object({ value: z.literal("ok") }),
					}),
				},
			});
			let valid = false;
			for await (const event of result.fullStream) {
				if (event.type === "error") throw new Error("Model stream failed.");
				if (
					event.type === "tool-call" &&
					event.toolName === "connection_check" &&
					z.object({ value: z.literal("ok") }).safeParse(event.input).success
				)
					valid = true;
			}
			if (!valid)
				throw new Error("Model did not return a valid streamed tool call.");
			if (
				!(await markModelVerified(
					userId,
					connectionId,
					connection.revision,
					modelId,
				))
			)
				throw new Error("Connection changed; verify its new credentials.");
		} finally {
			await transport.close();
		}
	});
}
