import type { SessionTurnStatus } from "#/domain/session-item";

/**
 * A turn that settled with no executor left to say so: the lease sweep
 * (expireApiTurnLeases) failed it because its Durable Object or its box
 * stopped renewing it, or a box turn ran out of takeovers. Its chat's object
 * is told, so the crew (Y²) and the user's hub stop showing it as working:
 * before, only the turn's own loop or the box's finalize told them, and a
 * turn that ended this way stayed "working" there for good.
 */
export type SettledElsewhere = {
	readonly userId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly turnStatus: SessionTurnStatus;
};

type Deliver = (note: SettledElsewhere) => Promise<unknown>;
let deliver: Deliver | null = null;

/** The edge registers how a chat's object is reached (user-hub-notes-binding.ts); elsewhere nothing is sent. */
export function deliverTurnSettleNotesDirectly(next: Deliver | null) {
	deliver = next;
}

/** Bookkeeping: never fails the sweep; a lost note is logged. */
export async function noteTurnsSettledElsewhere(
	notes: readonly SettledElsewhere[],
) {
	const send = deliver;
	if (!send || !notes.length) return;
	const results = await Promise.allSettled(notes.map((note) => send(note)));
	const lost = results.filter((result) => result.status === "rejected").length;
	if (lost)
		console.warn("Chats were not told their turn settled.", {
			lost,
			of: notes.length,
		});
}
