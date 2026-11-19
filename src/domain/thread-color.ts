import { helperColor } from "./helper-names";

/**
 * A thread's colour, the one its Y mark and working spinner take in the
 * sidebar. It is the same colour scheme as an agent's: the helpers of a chat
 * take the next of HELPER_COLORS in start order (helperColor), and a project's
 * threads take it in the order they were made, which is the thread's number
 * (src/domain/thread-label.ts). So a thread keeps its colour as others come
 * and go, neighbours differ, and the colours are the ones already tuned for
 * the dark background.
 *
 * A thread without a number (a row from before the numbers) takes one from its
 * chat id instead, as stable.
 */
export function threadColor(thread: {
	readonly id: string;
	readonly threadNumber?: number | null;
}) {
	if (thread.threadNumber != null && thread.threadNumber > 0)
		return helperColor(thread.threadNumber - 1);
	let hash = 2166136261;
	for (let index = 0; index < thread.id.length; index++) {
		hash ^= thread.id.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return helperColor(hash >>> 0);
}
