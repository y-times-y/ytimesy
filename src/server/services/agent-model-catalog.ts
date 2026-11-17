import type { AgentProviderId } from "#/domain/agent-provider";
import { loadAgentModelCatalog } from "#/server/adapters/agent-model-catalog";
import { codexSubscriptionCatalog } from "#/server/adapters/codex-subscription";
import { hasManagedCodexAuth } from "#/server/auth/codex-managed-auth";
import { apiModelCatalog } from "./api-workspace-session";

/** The models the composer lists for a runtime: what the browser's catalog read returns. */
export async function agentModelCatalog(
	userId: string,
	provider: AgentProviderId,
	options: { force?: boolean } = {},
) {
	if (provider === "api") return apiModelCatalog(userId);
	if (provider === "codex" && (await hasManagedCodexAuth(userId)))
		return codexSubscriptionCatalog(userId, options);
	return loadAgentModelCatalog(userId, provider);
}
