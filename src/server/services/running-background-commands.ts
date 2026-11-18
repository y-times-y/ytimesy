import {
	type RunningBackgroundCommand,
	runningBackgroundCommands,
} from "#/domain/background-command";
import { sessionItemsFromUnknown } from "#/domain/session-item";
import { backgroundCommandItemsForOwner } from "#/server/adapters/agent-sessions";
import { backgroundCommandMaxSeconds } from "#/server/services/api-command-scope";

/**
 * The running background commands of the user's chats (a chat and its
 * subagents), by chat id, for the agents list. As the timelines record them.
 * The agents list asks every few seconds, so only the items that record a
 * background command are read, never the whole transcripts.
 */
export async function runningBackgroundCommandsByChat(
	userId: string,
	sessionIds: readonly string[],
): Promise<Record<string, RunningBackgroundCommand[]>> {
	const now = Date.now();
	const ids = [...new Set(sessionIds)];
	const items = await backgroundCommandItemsForOwner(userId, ids, {
		records: true,
	});
	return Object.fromEntries(
		ids.map((sessionId) => [
			sessionId,
			runningBackgroundCommands(
				sessionItemsFromUnknown(items.get(sessionId) ?? []),
				now,
				backgroundCommandMaxSeconds(),
			),
		]),
	);
}
