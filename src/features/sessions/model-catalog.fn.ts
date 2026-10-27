import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { parseRuntimeId } from "#/domain/agent-provider";
import { requireUser } from "#/server/auth/auth";
import { agentModelCatalog } from "#/server/services/agent-model-catalog";

export const getAgentModelCatalog = createServerFn({ method: "GET" })
	.validator((data: { provider: string }) => ({
		provider: parseRuntimeId(data.provider),
	}))
	.handler(async ({ data }) => {
		const user = await requireUser(getRequest().headers);
		return agentModelCatalog(user.id, data.provider);
	});
