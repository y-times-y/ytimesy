import {
	type RunningBackgroundCommand,
	runningBackgroundCommands,
} from "#/domain/background-command";
import { sessionItemsFromUnknown } from "#/domain/session-item";
import { agentSessionForOwner } from "#/server/adapters/agent-sessions";
import { backgroundCommandMaxSeconds } from "#/server/services/api-command-scope";

/**
 * The running background commands of the user's chats (a chat and its
 * subagents), by chat id, for the agents list. As the timelines record them.
 */
export async function runningBackgroundCommandsByChat(
	userId: string,
	sessionIds: readonly string[],
): Promise<Record<string, RunningBackgroundCommand[]>> {
	const now = Date.now();
	const entries = await Promise.all(
		[...new Set(sessionIds)].map(async (sessionId) => {
			const session = await agentSessionForOwner(userId, sessionId);
			return [
				sessionId,
				session
					? runningBackgroundCommands(
							sessionItemsFromUnknown(session.items),
							now,
							backgroundCommandMaxSeconds(),
						)
					: [],
			] as const;
		}),
	);
	return Object.fromEntries(entries);
}
