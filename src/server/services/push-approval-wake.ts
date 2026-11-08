import { Effect } from "effect";
import { wakeMessageId } from "#/domain/pull-request-wake";
import { agentSessionForOwner } from "../adapters/agent-sessions";
import { sendComposerMessage } from "./queued-user-messages";
import type { WorkspaceMachines } from "./workspace-machines";

/** What the agent reads once the user's Push landed, as if the user had written it. */
export function pushedMessageText(input: { detail: string }) {
	const commit = input.detail ? ` (${input.detail})` : "";
	return `I pushed${commit}: the push you asked approval for went through. Continue with whatever waited for it (deploying, for example).`;
}

/**
 * Wakes the chat after the user's Push landed: the agent gets a message and
 * carries on (deploying, say) instead of waiting for the user to say so. The
 * message id is stable per request, so a replayed click never sends twice.
 * Bookkeeping: a chat that cannot be woken never fails the push itself.
 */
export async function wakeChatAfterPush(
	machines: WorkspaceMachines,
	input: {
		userId: string;
		sessionId: string;
		/** The card's item id: one wake per card. */
		cardId: string;
		detail: string;
	},
) {
	try {
		const chat = await agentSessionForOwner(input.userId, input.sessionId);
		if (!chat?.listedModelId) return;
		await Effect.runPromise(
			sendComposerMessage(
				machines,
				{
					userId: input.userId,
					projectId: chat.projectId,
					sessionId: chat.id,
					harnessId: chat.harness,
					createNew: false,
				},
				{
					text: pushedMessageText(input),
					modelId: chat.listedModelId,
					idempotencyKey: wakeMessageId(`push:${input.cardId}`),
				},
			),
		);
	} catch (error) {
		console.warn("The chat was not woken after its push.", {
			sessionId: input.sessionId,
			error: error instanceof Error ? error.message : "unknown",
		});
	}
}
