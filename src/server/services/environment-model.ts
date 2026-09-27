import type { EnvironmentModel } from "#/domain/environment-model";
import { environmentModelRequest } from "#/domain/environment-model";
import { parseModelRouteId } from "#/domain/model-connection";
import { loadModelConnection } from "../adapters/model-connections";
import { hasManagedCodexAuth } from "../auth/codex-managed-auth";

/** Freeze explicit selection in the job; never guess from another chat or connected account. */
export async function resolveEnvironmentModel(
	userId: string,
	raw: unknown,
): Promise<EnvironmentModel | null> {
	if (raw == null) return null;
	const request = environmentModelRequest.parse(raw);
	if (request.harness === "codex") {
		if (!(await hasManagedCodexAuth(userId)))
			throw new Error(
				"Connect the selected Codex account before requesting setup repair.",
			);
		return { provider: "codex", modelId: request.modelId };
	}
	if (!request.allowApi)
		throw new Error("Confirm API usage for setup repair before continuing.");
	const route = parseModelRouteId(request.modelId);
	const connection =
		route && (await loadModelConnection(userId, route.connectionId));
	if (
		!route ||
		!connection?.models.some(
			(model) => model.id === route.modelId && model.toolStreamingVerified,
		)
	)
		throw new Error(
			"Select a verified model connection owned by this account.",
		);
	return {
		provider: "api",
		connectionId: connection.id,
		revision: connection.revision,
		modelId: route.modelId,
		allowApi: true,
	};
}
