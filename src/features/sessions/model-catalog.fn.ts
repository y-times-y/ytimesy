import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { loadAgentModelCatalog } from "#/server/adapters/agent-model-catalog";
import { requireUser } from "#/server/auth/auth";
import { parseHarnessId } from "#/server/secrets/harness-key-store";

export const getAgentModelCatalog = createServerFn({ method: "GET" })
	.validator((data: { provider: string }) => ({
		provider: parseHarnessId(data.provider),
	}))
	.handler(async ({ data }) => {
		const user = await requireUser(getRequest().headers);
		return loadAgentModelCatalog(user.id, data.provider);
	});
