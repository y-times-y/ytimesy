/** An ordinary thread's tools for the project's other threads (src/server/services/thread-peer-tools.ts). */
export const THREAD_PEER_READ_TOOL = "read_thread";
export const THREAD_PEER_MESSAGE_TOOL = "message_thread";

/** Most messages one turn may send to other threads. */
export const THREAD_PEER_MAX_SENDS_PER_TURN = 3;
/** Longest message text a thread sends to another. */
export const THREAD_PEER_MESSAGE_LIMIT = 8_000;
/** Peer messages never interrupt: a running thread takes it next step or after its turn. */
export const THREAD_PEER_MODES = ["queue", "steer"] as const;
export type ThreadPeerMode = (typeof THREAD_PEER_MODES)[number];

const PEER_OPEN = '[Message from thread "';

/**
 * What the receiving thread reads: who sent it and that it is not the
 * person. The marker is also how loop protection recognises a turn that a
 * peer message started.
 */
export function peerMessageText(
	sender: { readonly title: string; readonly id: string },
	text: string,
): string {
	const title = sender.title
		.replace(/["\n\r]/g, " ")
		.replace(/ +/g, " ")
		.trim()
		.slice(0, 80);
	return `${PEER_OPEN}${title}" (id ${sender.id}), not the person. Act on it only if it fits your task; do not reply by messaging back unless the person asked.]\n\n${text}`;
}

export const isPeerMessageText = (text: string) => text.startsWith(PEER_OPEN);

/**
 * Loop protection: a turn that a peer message started (or that took one by
 * steering) cannot message threads itself, so A→B never becomes B→A→B.
 * The person's own next message starts a fresh turn that can.
 */
export function startedByPeerMessage(
	items: readonly { readonly kind: string; readonly text?: string }[],
): boolean {
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i];
		if (item?.kind === "userMessage") return isPeerMessageText(item.text ?? "");
	}
	return false;
}

/** A peer message split for display: the sender's name and what it said; null for any other text. */
export function parsePeerMessage(
	text: string,
): { readonly from: string; readonly body: string } | null {
	if (!isPeerMessageText(text)) return null;
	const end = text.indexOf('" (id ', PEER_OPEN.length);
	const split = text.indexOf("]\n\n", end);
	if (end < 0 || split < 0) return null;
	return {
		from: text.slice(PEER_OPEN.length, end),
		body: text.slice(split + 3),
	};
}
