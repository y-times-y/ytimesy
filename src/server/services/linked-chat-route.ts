import type { AgentProviderId } from "#/domain/agent-provider";
import { parseClaudeCodeRouteId } from "#/domain/claude-code-route";
import { preferredListedModelId } from "#/domain/listed-model";
import { parseModelRouteId } from "#/domain/model-connection";
import { NO_MODEL_CONNECTED_MESSAGE } from "#/domain/no-model-connected";
import { hasManagedCodexAuth } from "../auth/codex-managed-auth";
import { agentModelCatalog } from "./agent-model-catalog";

/** Marks "no model is connected": the client opens the model setup step. */
export const NO_MODEL_CONNECTED = "no-model-connected";

export class NoModelConnectedError extends Error {
	readonly code = NO_MODEL_CONNECTED;
	constructor() {
		super(NO_MODEL_CONNECTED_MESSAGE);
		this.name = "NoModelConnectedError";
	}
}

export type LinkedChatRouteDeps = {
	readonly hasSubscription: (userId: string) => Promise<boolean>;
	readonly catalog: (
		userId: string,
		harness: AgentProviderId,
	) => Promise<readonly { readonly id: string }[]>;
};

const liveDeps: LinkedChatRouteDeps = {
	hasSubscription: (userId) => hasManagedCodexAuth(userId).catch(() => false),
	catalog: (userId, harness) =>
		agentModelCatalog(userId, harness).catch(() => []),
};

/**
 * The harness and model a chat started from a GitHub item uses: the one the
 * composer would use. The requested model is kept when a connected route
 * lists it; otherwise the first connected route's preferred model. A route
 * the user has not connected is never chosen (Codex needs its own sign-in),
 * and with none connected this throws NoModelConnectedError.
 */
export async function resolveLinkedChatRoute(
	input: {
		readonly userId: string;
		readonly harnessId: AgentProviderId;
		readonly modelId: string;
	},
	deps: LinkedChatRouteDeps = liveDeps,
): Promise<{ readonly harnessId: AgentProviderId; readonly modelId: string }> {
	const requested = input.modelId.trim();
	const requestedHarness: AgentProviderId =
		parseModelRouteId(requested) || parseClaudeCodeRouteId(requested)
			? "api"
			: input.harnessId;
	const order: AgentProviderId[] = [
		requestedHarness,
		...(["codex", "api"] as const).filter((id) => id !== requestedHarness),
	];
	let fallback: { harnessId: AgentProviderId; modelId: string } | null = null;
	for (const harnessId of order) {
		if (harnessId === "codex" && !(await deps.hasSubscription(input.userId)))
			continue;
		const models = await deps.catalog(input.userId, harnessId);
		if (requested && models.some((model) => model.id === requested))
			return { harnessId, modelId: requested };
		const preferred = preferredListedModelId(models);
		if (!fallback && preferred) fallback = { harnessId, modelId: preferred };
	}
	if (!fallback) throw new NoModelConnectedError();
	return fallback;
}
