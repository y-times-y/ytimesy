import type { AgentProviderId } from "#/domain/agent-provider";
import { loadAgentModelCatalog } from "#/server/adapters/agent-model-catalog";
import { codexSubscriptionCatalog } from "#/server/adapters/codex-subscription";
import { hasManagedCodexAuth } from "#/server/auth/codex-managed-auth";
import { apiModelCatalog } from "./api-workspace-session";

/** The models the composer lists for a runtime: what the browser's catalog read returns. */
export async function agentModelCatalog(
	userId: string,
	provider: AgentProviderId,
) {
	if (provider === "api") return apiModelCatalog(userId);
	if (provider === "codex" && (await hasManagedCodexAuth(userId)))
		return codexSubscriptionCatalog(userId);
	return loadAgentModelCatalog(userId, provider);
}
