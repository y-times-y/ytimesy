import type { ToolSet } from "ai";
import type { ApiAgentEvent } from "#/domain/api-agent-event";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import { codexSubscriptionModel } from "../adapters/codex-subscription";
import { loadSidekick, saveSidekick } from "../adapters/fusion-sidekick";
import { type FusionConfig, runFusionAgent } from "./fusion-agent";
import type { ModelAgentInput } from "./model-agent-loop";

/**
 * Fusion runs for root sessions on the Codex subscription when a sidekick
 * model is configured. The lead is the turn's model; the classifier may
 * upgrade a struggling sidekick to it at compaction.
 */
export function fusionConfigForTurn(input: {
	session: AgentSessionRecord;
	subscription: boolean;
	stepMode: boolean;
	leadModelId: string;
}): FusionConfig | null {
	const sidekickModelId = process.env.YTIMESY_FUSION_SIDEKICK_MODEL?.trim();
	if (
		!sidekickModelId ||
		sidekickModelId === input.leadModelId ||
		input.session.parentSessionId ||
		!input.subscription ||
		input.stepMode
	)
		return null;
	return {
		sidekickModelId,
		upgradeModelId: input.leadModelId,
		classifierModelId:
			process.env.YTIMESY_FUSION_CLASSIFIER_MODEL?.trim() || "gpt-5.6-luna",
	};
}

export async function runFusionTurn(input: {
	sessionId: string;
	lead: ModelAgentInput;
	config: FusionConfig;
	workspaceTools: ToolSet;
	beforeSidekickRequest: () => Promise<void>;
	onSidekickEvent: (event: ApiAgentEvent) => Promise<void>;
}) {
	const { lead, sessionId } = input;
	const makeRuntime = async (modelId: string, effort: string) => {
		try {
			return await codexSubscriptionModel(
				lead.userId,
				modelId,
				effort,
				false,
				`${sessionId}:${modelId}`,
			);
		} catch (error) {
			// Not every model offers every effort; fall back to the model's default.
			if (!(error instanceof Error) || !/reasoning level/.test(error.message))
				throw error;
			return codexSubscriptionModel(
				lead.userId,
				modelId,
				undefined,
				false,
				`${sessionId}:${modelId}`,
			);
		}
	};
	return runFusionAgent({
		lead,
		leadRuntime: await codexSubscriptionModel(
			lead.userId,
			lead.modelId,
			lead.reasoning,
			false,
			sessionId,
		),
		workspaceTools: input.workspaceTools,
		config: input.config,
		makeRuntime,
		sidekick: await loadSidekick(
			lead.userId,
			sessionId,
			input.config.sidekickModelId,
		),
		saveSidekick: (state) => saveSidekick(lead.userId, sessionId, state),
		onSidekickEvent: input.onSidekickEvent,
		beforeSidekickRequest: input.beforeSidekickRequest,
	});
}
