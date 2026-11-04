import {
	type AgentProviderId,
	DEFAULT_COMPOSER_HARNESS_ID,
} from "./agent-provider";
import { preferredListedModelId } from "./listed-model";

/** The model a project's own setup runs on, chosen by the server. */
export type SetupModel = {
	readonly harnessId: AgentProviderId;
	readonly modelId: string;
};

/**
 * The model a new project's setup runs on, with no tab to ask: the model the
 * person last used (their latest chat's), when its route still lists it;
 * else the preferred model of that route, the default route, then any other
 * connected one. Null when nothing is connected.
 */
export function chooseSetupModel(input: {
	/** The person's latest chat's route and model, if any. */
	readonly lastUsed: {
		readonly harnessId: AgentProviderId;
		readonly modelId: string;
	} | null;
	/** What each route lists now; empty when it is not connected. */
	readonly catalogs: Readonly<
		Record<AgentProviderId, readonly { readonly id: string }[]>
	>;
}): SetupModel | null {
	const order = [
		...new Set<AgentProviderId>([
			...(input.lastUsed ? [input.lastUsed.harnessId] : []),
			DEFAULT_COMPOSER_HARNESS_ID,
			"codex",
			"api",
		]),
	];
	for (const harnessId of order) {
		const models = input.catalogs[harnessId];
		if (!models.length) continue;
		const lastUsedId =
			input.lastUsed?.harnessId === harnessId
				? input.lastUsed.modelId
				: undefined;
		const modelId = preferredListedModelId(models, { lastUsedId });
		if (modelId) return { harnessId, modelId };
	}
	return null;
}

/** The setup chat's one line when no model is connected to run it. */
export const SETUP_WAITS_FOR_MODEL =
	"Setup is waiting for a model. Sign in to ChatGPT or add an API key, then use Rerun setup in Settings.";
