import {
	applyConversationDelta,
	conversationDeltaBodySchema,
	type TranscriptWindow,
	transcriptWindowSchema,
} from "./conversation-delivery";
import type { SessionProgress } from "./session-progress";

/**
 * The open chat's copy of its live progress stream: each full `progress`
 * event replaces it; each `delta` event is merged into it. A delta it cannot
 * merge (it missed one, or holds no copy the delta applies to) answers
 * "resync": the caller reopens the stream, which starts with a full snapshot.
 */
export function createLiveProgressCopy(sessionId: string) {
	let copy: { progress: SessionProgress; window?: TranscriptWindow } | null =
		null;
	return {
		/** A full snapshot's data; null when it is not this chat's. */
		full(data: unknown): SessionProgress | null {
			const progress = data as SessionProgress & { window?: unknown };
			if (
				!progress ||
				progress.sessionId !== sessionId ||
				!Array.isArray(progress.items)
			)
				return null;
			const window = transcriptWindowSchema.safeParse(progress.window);
			// Without its window (an older server) the copy takes no delta.
			copy = { progress, window: window.success ? window.data : undefined };
			return progress;
		},
		/** A delta's data merged into the copy; null when it is not this chat's. */
		delta(data: unknown): SessionProgress | null | "resync" {
			if ((data as { sessionId?: unknown } | null)?.sessionId !== sessionId)
				return null;
			const parsed = conversationDeltaBodySchema.safeParse(data);
			if (!parsed.success || !copy) return "resync";
			const merged = applyConversationDelta(copy, parsed.data);
			if (!merged) {
				copy = null;
				return "resync";
			}
			const progress = {
				...merged.progress,
				sessionId,
			} as unknown as SessionProgress;
			copy = { progress, window: merged.window };
			return progress;
		},
	};
}
