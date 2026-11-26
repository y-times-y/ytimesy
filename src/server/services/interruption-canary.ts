import { Effect } from "effect";
import { DEFAULT_COMPOSER_HARNESS_ID } from "#/domain/agent-provider";
import { markCanaryChat } from "../adapters/canary-chat";
import { canaryConfigRow } from "../adapters/interruption-events";
import type { CanaryDeps } from "./interruption-monitoring";
import { canaryConfig } from "./interruption-monitoring";
import { sendComposerMessage } from "./queued-user-messages";
import type { WorkspaceMachines } from "./workspace-machines";

/** The canary's production dependencies, or null while its account is not configured. */
export async function productionCanary(
	machines: WorkspaceMachines,
): Promise<CanaryDeps | null> {
	// The environment wins; otherwise the operator's row. Any read failure: inert.
	const config = canaryConfig() ?? (await canaryConfigRow().catch(() => null));
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
			// Internal from here on: hidden from the owner's lists and stats, and only
			// this sender can post into it (canary-chat.ts). A failed mark is retried by
			// the next send into the same chat.
			await markCanaryChat(config.userId, session.agentSessionId).catch(
				(error: unknown) =>
					console.warn("Marking the canary chat failed.", {
						error: error instanceof Error ? error.message : String(error),
					}),
			);
			return session.agentSessionId;
		},
	};
}
