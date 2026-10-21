import type { MemoryChangeSummary } from "./memory-overview";

/**
 * When the user's memory is next dreamed. A dream runs once the user's chats
 * have been idle for `idleMs` with activity the last dream did not cover,
 * found by a maintenance job every `tickMs`; every `reviewDays` a dream also
 * reviews the whole repo (merges duplicates, retires stale lines).
 */
export type MemoryDreamSchedule = {
	/** "soon": new activity waits for the idle window; "after-next-chat": nothing new to dream. */
	readonly next:
		| { readonly kind: "soon"; readonly at: string }
		| { readonly kind: "after-next-chat" }
		| { readonly kind: "off" };
	/** When the next whole-repo review is due; null: with the next dream (never reviewed). */
	readonly reviewDue: string | null;
};

export function memoryDreamSchedule(input: {
	now: Date;
	off: boolean;
	lastActivity: Date | null;
	dreamedThrough: Date | null;
	lastReview: Date | null;
	idleMs: number;
	tickMs: number;
	reviewDays: number;
}): MemoryDreamSchedule {
	const reviewDue = input.lastReview
		? new Date(
				input.lastReview.getTime() + input.reviewDays * 86_400_000,
			).toISOString()
		: null;
	if (input.off) return { next: { kind: "off" }, reviewDue };
	const pending =
		input.lastActivity &&
		(!input.dreamedThrough || input.dreamedThrough < input.lastActivity);
	if (!pending || !input.lastActivity)
		return { next: { kind: "after-next-chat" }, reviewDue };
	const ready = Math.max(
		input.now.getTime(),
		input.lastActivity.getTime() + input.idleMs,
	);
	const tick = Math.ceil(ready / input.tickMs) * input.tickMs;
	return {
		next: { kind: "soon", at: new Date(tick).toISOString() },
		reviewDue,
	};
}

/** What the Memory view shows about dreaming. */
export type MemoryDreamStatus = MemoryDreamSchedule & {
	/** When a dream last ran (whatever it changed), ISO. */
	readonly lastRunAt: string | null;
	/** The last whole-repo review, ISO. */
	readonly lastReviewAt: string | null;
	/** The newest commit a dream made, and what it changed. */
	readonly lastChange: {
		readonly at: string;
		/** The dream's own commit message, without the "Dream: " prefix. */
		readonly message: string;
		readonly summary: MemoryChangeSummary;
	} | null;
};

/** Commit message prefix of every dream commit (runMemoryDream). */
export const DREAM_COMMIT_PREFIX = "Dream: ";
