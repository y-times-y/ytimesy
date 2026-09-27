import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { parseRuntimeId } from "#/domain/agent-provider";
import { loadAgentModelCatalog } from "#/server/adapters/agent-model-catalog";
import { requireUser } from "#/server/auth/auth";
import { apiModelCatalog } from "#/server/services/api-workspace-session";

export const getAgentModelCatalog = createServerFn({ method: "GET" })
	.validator((data: { provider: string }) => ({
		provider: parseRuntimeId(data.provider),
	}))
	.handler(async ({ data }) => {
		const user = await requireUser(getRequest().headers);
		if (data.provider === "api") return apiModelCatalog(user.id);
		return loadAgentModelCatalog(user.id, data.provider);
	});
