import { SessionItemId } from "./ids";
import type { SessionItem } from "./session-item";

/** Shown when a turn ends failed and nothing else told the person why (the transcript is never silent). */
export const SILENT_FAILURE_MESSAGE =
	"This turn could not finish because of a problem on our side. Your message is saved; send it again in a moment and it will run.";

/**
 * `items` with a calm error item at the end when the turn failed without one.
 * An error item already after the last message from the person counts: nothing
 * is added twice.
 */
export function withFailureNotice(
	items: readonly SessionItem[],
	turnId: string,
	message: string = SILENT_FAILURE_MESSAGE,
): readonly SessionItem[] {
	let lastMessage = -1;
	items.forEach((item, index) => {
		if (item.kind === "userMessage") lastMessage = index;
	});
	if (items.slice(lastMessage + 1).some((item) => item.kind === "error"))
		return items;
	return [
		...items,
		{ kind: "error", id: SessionItemId(`${turnId}:lost`), message },
	];
}
