import { SessionItemId } from "./ids";
import type { SessionItem } from "./session-item";

/** The quiet line that closes a turn the user stopped. */
export const STOPPED_NOTICE = "Stopped";

/** Older messages are never marked: they predate recorded turn ends. */
const MARK_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * A settled turn's transcript: its messages record when the turn ended (the
 * agents list stops Main's clock there and "Worked for" reads it). Every
 * delivered message since the last recorded end is marked.
 */
export function settledTurnItems(
	items: readonly SessionItem[],
	endedAt: number,
): SessionItem[] {
	const next = [...items];
	for (let index = next.length - 1; index >= 0; index--) {
		const item = next[index];
		if (item?.kind !== "userMessage" || item.queued || !item.timing) continue;
		if (
			item.timing.completedAt !== undefined ||
			endedAt - item.timing.startedAt > MARK_WINDOW_MS
		)
			break;
		next[index] = {
			...item,
			timing: {
				...item.timing,
				completedAt: Math.max(item.timing.startedAt, endedAt),
			},
		};
	}
	return next;
}

/** A turn the user stopped closes with a "Stopped" notice, once. */
export function withStoppedNotice(
	items: readonly SessionItem[],
	turnId: string,
): SessionItem[] {
	const id = SessionItemId(`${turnId}:stopped`);
	if (items.some((item) => item.id === id)) return [...items];
	return [
		...items,
		{ kind: "notice", id, message: STOPPED_NOTICE, stopped: true },
	];
}
