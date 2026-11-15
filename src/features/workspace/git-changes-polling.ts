import { isTurnRunning, type SessionTurnStatus } from "#/domain/session-item";

/** How often the Diff panel re-reads git while the chat's turn runs. */
export const RUNNING_TURN_CHANGES_POLL_MS = 10_000;

/**
 * The Diff panel's git read polling. Each read is a guest command, which
 * resets a running VM's idle timer, so polling between turns kept a chat's
 * VM from ever pausing while the panel was open. Between turns nothing
 * changes the checkout on its own: the panel reads once when it opens, when
 * the window regains focus and when a turn ends (workspace-home.tsx).
 */
export function gitChangesPolling(turnStatus: SessionTurnStatus) {
	return {
		refetchInterval: isTurnRunning(turnStatus)
			? RUNNING_TURN_CHANGES_POLL_MS
			: (false as const),
		// A hidden tab does not poll; coming back to it reads once.
		refetchIntervalInBackground: false,
		refetchOnWindowFocus: true,
	};
}
