import type { AgentProviderId } from "#/domain/agent-provider";
import type { ListedModel } from "#/domain/listed-model";
import { database } from "./database";

export async function loadAgentModelCatalog(
	userId: string,
	provider: AgentProviderId,
): Promise<readonly ListedModel[]> {
	const result = await database().query<{ models: ListedModel[] }>(
		"select models from agent_model_catalog where user_id=$1 and provider=$2",
		[userId, provider],
	);
	return result.rows[0]?.models ?? [];
}

export async function saveAgentModelCatalog(
	userId: string,
	provider: AgentProviderId,
	models: readonly ListedModel[],
): Promise<void> {
	if (models.length === 0) return;
	await database().query(
		`insert into agent_model_catalog(user_id,provider,models) values($1,$2,$3::jsonb)
		 on conflict(user_id,provider) do update set models=excluded.models,updated_at=now()
		 where agent_model_catalog.models is distinct from excluded.models`,
		[userId, provider, JSON.stringify(models)],
	);
}
