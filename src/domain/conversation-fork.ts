/**
 * A forked chat opens at once with its copied conversation; its VM is copied
 * after, by a background job. The journal (a command receipt on the fork)
 * exists only while that copy is pending or failed: it holds the fork's
 * queued turns back and lets the user retry.
 */
export const CONVERSATION_FORK_REQUEST_ID = "conversation-fork";

/**
 * A copy still "preparing" after this long was interrupted: its job stops
 * after 15 minutes (a Durable Object alarm's limit).
 */
export const CONVERSATION_FORK_STALE_SECONDS = 16 * 60;

export type ConversationForkJournal = {
	readonly state: "preparing" | "failed";
	readonly sourceSessionId: string;
	readonly messageId: string;
	readonly branch: string;
	/** Each retry is a new attempt; an older attempt's writes are ignored. */
	readonly attempt: number;
	readonly message?: string;
	/** A failed attempt's VM that could not be deleted; the next attempt deletes it first. */
	readonly leftoverVm?: string;
};

export type ConversationForkStatus =
	| { readonly state: "preparing" }
	| { readonly state: "failed"; readonly message: string };

/** What the fork's chat shows: null once its VM is ready (no journal). */
export function conversationForkStatus(
	journal: ConversationForkJournal | null,
	updatedAt: Date | null,
	now: number,
): ConversationForkStatus | null {
	if (!journal) return null;
	if (journal.state === "failed")
		return {
			state: "failed",
			message: journal.message ?? "Couldn't fork this chat. Try again.",
		};
	if (
		updatedAt &&
		now - updatedAt.getTime() > CONVERSATION_FORK_STALE_SECONDS * 1000
	)
		return {
			state: "failed",
			message: "Preparing the fork stopped. Try again.",
		};
	return { state: "preparing" };
}
