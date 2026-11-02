import { chatSendNeedsGithub } from "#/domain/send-blocked";
import { sessionItemsFromUnknown } from "#/domain/session-item";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import { githubConnectionExists } from "../auth/github-connection";

/** A send here would need the user's GitHub, which is not connected. */
export async function githubSendBlocked(
	userId: string,
	chat: Pick<
		AgentSessionRecord,
		"parentSessionId" | "workingBranch" | "selectedBranch" | "items"
	> | null,
): Promise<boolean> {
	const needsGithub = chatSendNeedsGithub(
		chat && {
			parentSessionId: chat.parentSessionId,
			workingBranch: chat.workingBranch,
			selectedBranch: chat.selectedBranch,
			hasConversation: sessionItemsFromUnknown(chat.items).some(
				(item) => item.kind === "userMessage",
			),
		},
	);
	if (!needsGithub) return false;
	// A failed read never blocks: the send reports its own error.
	return !(await githubConnectionExists(userId).catch(() => true));
}
