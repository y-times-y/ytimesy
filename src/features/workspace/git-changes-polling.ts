import {
	isTurnRunning,
	type SessionItem,
	type SessionTurnStatus,
} from "#/domain/session-item";

/** How often the Diff panel re-reads git while the chat's turn runs. */
export const RUNNING_TURN_CHANGES_POLL_MS = 10_000;

/**
 * The Diff panel's git read polling. Each read is a guest command, which
 * resets a running VM's idle timer, so polling between turns kept a chat's
 * VM from ever pausing while the panel was open. Between turns nothing
 * changes the checkout on its own: the panel reads once when it opens, when
 * the window regains focus and when a turn ends (workspace-home.tsx).
 * While the chat's live progress stream is open (`streamOpen`), a running
 * turn is not polled either: its tool steps arrive on the stream, and the
 * panel reads after them (changesReadMark).
 */
export function gitChangesPolling(
	turnStatus: SessionTurnStatus,
	streamOpen?: () => boolean,
) {
	const running = isTurnRunning(turnStatus);
	return {
		refetchInterval: streamOpen
			? () =>
					running && !streamOpen()
						? RUNNING_TURN_CHANGES_POLL_MS
						: (false as const)
			: running
				? RUNNING_TURN_CHANGES_POLL_MS
				: (false as const),
		// A hidden tab does not poll; coming back to it reads once.
		refetchIntervalInBackground: false,
		refetchOnWindowFocus: true,
	};
}

/**
 * While the turn streams, the Diff panel reads git after finished tool steps
 * at most this often (a busy agent finishes several a minute); the turn's
 * end reads at once.
 */
export const STREAMED_CHANGES_READ_MS = 60_000;

/**
 * How many of the transcript's tool steps that may have changed files have
 * finished. When it grows during a streamed turn, the Diff panel reads git
 * (at most every STREAMED_CHANGES_READ_MS).
 */
export function changesReadMark(items: readonly SessionItem[]): number {
	let mark = 0;
	for (const item of items)
		if (
			(item.kind === "fileChange" ||
				item.kind === "commandExecution" ||
				item.kind === "dynamicToolCall" ||
				item.kind === "mcpToolCall") &&
			item.status !== "inProgress"
		)
			mark += 1;
	return mark;
}
