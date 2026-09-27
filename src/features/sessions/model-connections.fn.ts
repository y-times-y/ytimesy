import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { Effect } from "effect";
import { z } from "zod";
import { modelProvider } from "#/domain/model-connection";
import { browseModels } from "#/server/adapters/browse-models";
import {
	listModelConnections,
	removeModelConnection,
} from "#/server/adapters/model-connections";
import { requireUser } from "#/server/auth/auth";
import { requireSameOrigin } from "#/server/http";
import {
	connectApiModels,
	verifyApiModel,
} from "#/server/services/model-connections";

export const getBrowseModels = createServerFn({ method: "GET" }).handler(
	async () => {
		await requireUser(getRequest().headers);
		return browseModels();
	},
);

export const getModelConnections = createServerFn({ method: "GET" }).handler(
	async () => {
		const user = await requireUser(getRequest().headers);
		return listModelConnections(user.id);
	},
);

export const saveModelConnectionFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		z
			.object({
				id: z.uuid().optional(),
				provider: modelProvider,
				label: z.string().min(1).max(80),
				apiKey: z.string().min(8).max(4096),
				baseUrl: z.string().max(2048).optional(),
			})
			.strict()
			.parse(data),
	)
	.handler(async ({ data }) => {
		const request = getRequest();
		requireSameOrigin(request);
		const user = await requireUser(request.headers);
		try {
			await Effect.runPromise(connectApiModels(user.id, data));
		} catch {
			throw new Error(
				"Could not connect. Check the API key, public HTTPS endpoint, and model-list permission.",
			);
		}
		return listModelConnections(user.id);
	});

export const verifyModelConnectionFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		z
			.object({ connectionId: z.uuid(), modelId: z.string().min(1).max(512) })
			.strict()
			.parse(data),
	)
	.handler(async ({ data }) => {
		const request = getRequest();
		requireSameOrigin(request);
		const user = await requireUser(request.headers);
		try {
			await Effect.runPromise(
				verifyApiModel(user.id, data.connectionId, data.modelId),
			);
		} catch {
			throw new Error(
				"Verification failed. Check model access, credit, and streaming tool support. Wait 30 seconds before retrying.",
			);
		}
		return listModelConnections(user.id);
	});

export const deleteModelConnectionFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => z.object({ id: z.uuid() }).strict().parse(data))
	.handler(async ({ data }) => {
		const request = getRequest();
		requireSameOrigin(request);
		const user = await requireUser(request.headers);
		await removeModelConnection(user.id, data.id);
		return listModelConnections(user.id);
	});
