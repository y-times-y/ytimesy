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

/** Who sent a peer message: another thread, a captain, or the project's leader (the Super agent). */
export type PeerKind = "thread" | "captain" | "leader";

const PEER_OPENERS: Record<PeerKind, string> = {
	thread: '[Message from thread "',
	captain: '[Message from captain "',
	leader: '[Message from the Super agent "',
};
const PEER_KINDS = Object.keys(PEER_OPENERS) as PeerKind[];
const peerKindOf = (text: string): PeerKind | null =>
	PEER_KINDS.find((kind) => text.startsWith(PEER_OPENERS[kind])) ?? null;

/**
 * What the receiving thread or agent reads: who sent it and that it is not
 * the person. The marker is also how loop protection recognises a turn that
 * a peer message started. Captains and the leader use the same wrapper as
 * threads, with their own label.
 */
export function peerMessageText(
	sender: {
		readonly title: string;
		readonly id: string;
		readonly kind?: PeerKind;
	},
	text: string,
): string {
	const title = sender.title
		.replace(/["\n\r]/g, " ")
		.replace(/ +/g, " ")
		.trim()
		.slice(0, 80);
	const act =
		sender.kind === "thread" || !sender.kind
			? "Act on it only if it fits your task"
			: "Act on it only if it fits your role";
	return `${PEER_OPENERS[sender.kind ?? "thread"]}${title}" (id ${sender.id}), not the person. ${act}; do not reply by messaging back unless the person asked.]\n\n${text}`;
}

export const isPeerMessageText = (text: string) => peerKindOf(text) !== null;

/**
 * Loop protection: a turn that a peer message started (or that took one by
 * steering) cannot message threads or agents itself, so A→B never becomes
 * B→A→B. The person's own next message starts a fresh turn that can.
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

export type PeerMessage = {
	readonly from: string;
	readonly body: string;
	readonly kind: PeerKind;
};

/** A peer message split for display: the sender's name and kind and what it said; null for any other text. */
export function parsePeerMessage(text: string): PeerMessage | null {
	const kind = peerKindOf(text);
	if (!kind) return null;
	const open = PEER_OPENERS[kind].length;
	const end = text.indexOf('" (id ', open);
	const split = text.indexOf("]\n\n", end);
	if (end < 0 || split < 0) return null;
	return { from: text.slice(open, end), body: text.slice(split + 3), kind };
}

/** "thread Fix login", "captain seo", "Super agent otto": how a message's sender is named in labels. */
export function peerSenderLabel(
	peer: Pick<PeerMessage, "from" | "kind">,
): string {
	return peer.kind === "leader"
		? `Super agent ${peer.from}`
		: `${peer.kind} ${peer.from}`;
}
