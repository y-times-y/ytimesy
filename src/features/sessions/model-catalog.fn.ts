import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { parseRuntimeId } from "#/domain/agent-provider";
import { requireUser } from "#/server/auth/auth";
import { agentModelCatalog } from "#/server/services/agent-model-catalog";

export const getAgentModelCatalog = createServerFn({ method: "GET" })
	.validator((data: { provider: string; force?: boolean }) => ({
		provider: parseRuntimeId(data.provider),
		// Asks the provider again instead of answering from the server's copy
		// (a failed turn's recheck, or the person's "Refresh models").
		force: data.force === true,
	}))
	.handler(async ({ data }) => {
		const user = await requireUser(getRequest().headers);
		return agentModelCatalog(user.id, data.provider, { force: data.force });
	});
