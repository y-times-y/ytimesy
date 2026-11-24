import { Effect } from "effect";
import { DEFAULT_COMPOSER_HARNESS_ID } from "#/domain/agent-provider";
import type { CanaryDeps } from "./interruption-monitoring";
import { canaryConfig } from "./interruption-monitoring";
import { sendComposerMessage } from "./queued-user-messages";
import type { WorkspaceMachines } from "./workspace-machines";

/** The canary's production dependencies, or null while its account is not configured. */
export function productionCanary(
	machines: WorkspaceMachines,
): CanaryDeps | null {
	const config = canaryConfig();
	if (!config) return null;
	return {
		config,
		send: async (text, sessionId) => {
			const session = await Effect.runPromise(
				sendComposerMessage(
					machines,
					{
						userId: config.userId,
						projectId: config.projectId,
						harnessId: DEFAULT_COMPOSER_HARNESS_ID,
						sessionId: sessionId ?? undefined,
						createNew: sessionId === null,
					},
					{ text, modelId: config.modelId },
				),
			);
			if (!session.agentSessionId)
				throw new Error("The canary send returned no chat.");
			return session.agentSessionId;
		},
	};
}
