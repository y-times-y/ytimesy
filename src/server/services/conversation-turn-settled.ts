import { randomUUID } from "node:crypto";
import { coordinateConversationTurn } from "../adapters/conversation-turn-control";

export const TURN_STILL_FINISHING =
	"The last turn is still finishing. Try again in a moment.";

/**
 * Confirms the chat's last turn has fully settled, without waiting, and holds
 * its coordination lease until the returned release is called.
 *
 * A stopped turn reads idle as soon as it is finalized, but its runner still
 * stops its commands (and may land a last tool write) before it releases the
 * chat's coordination lease. Acquiring that lease under a fresh identity
 * succeeds only once the previous turn released it (or its lease expired), and
 * holding it keeps a restarted runner from reclaiming the old turn meanwhile.
 */
export async function holdSettledConversationTurn(
	userId: string,
	sessionId: string,
): Promise<() => Promise<void>> {
	const probe = {
		userId,
		sessionId,
		turnId: randomUUID(),
		leaseId: randomUUID(),
	};
	const acquired = await coordinateConversationTurn("acquire", probe).catch(
		() => {
			throw new Error(
				"Could not confirm the last turn has finished. Try again in a moment.",
			);
		},
	);
	if (!acquired) throw new Error(TURN_STILL_FINISHING);
	return async () => {
		// An unreleased probe expires with its lease; nothing else depends on it.
		await coordinateConversationTurn("release", probe).catch(() => {});
	};
}
