import type { AgentProviderId } from "#/domain/agent-provider";
import type { ListedModel } from "#/domain/listed-model";
import { withoutRetiredModels } from "#/domain/retired-model";
import { database } from "./database";

export async function loadAgentModelCatalog(
	userId: string,
	provider: AgentProviderId,
): Promise<readonly ListedModel[]> {
	const result = await database().query<{ models: ListedModel[] }>(
		"select models from agent_model_catalog where user_id=$1 and provider=$2",
		[userId, provider],
	);
	// A saved catalog can predate a retirement.
	return withoutRetiredModels(result.rows[0]?.models ?? []);
}
