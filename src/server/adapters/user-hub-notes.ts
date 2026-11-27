import { MAX_HUB_NOTE_TOPICS, userHubEnabledFor } from "#/domain/user-hub";
import { startAfterResponse } from "./after-response";
import { postUserHubNote } from "./realtime-delivery";

type DirectNote = (userId: string, topics: readonly string[]) => Promise<void>;
let direct: DirectNote | null = null;

/**
 * Inside the edge executor, notes go straight to the user's hub through its
 * binding instead of a signed request to itself.
 */
export function deliverUserHubNotesDirectly(note: DirectNote) {
	direct = note;
}

/** A burst of notes for one user is sent as one (a thread start touches several topics). */
export const HUB_NOTE_COALESCE_MS = 250;
const pending = new Map<string, Set<string>>();

/**
 * Tells the user's hub (their open tabs) that these topics changed
 * (hubTopic), so a tab reads them once instead of polling. Fire and forget:
 * the action never waits on it (in a web request it finishes after the
 * response), and a failure is only logged. Nothing for a user without the
 * hub.
 */
export function noteUserHub(
	userId: string | null | undefined,
	topics: readonly string[],
): void {
	if (
		!userId ||
		!topics.length ||
		!userHubEnabledFor(process.env.YTIMESY_USER_HUB_USERS, userId)
	)
		return;
	const send = async (sent: readonly string[]) => {
		try {
			if (direct) await direct(userId, sent);
			else await postUserHubNote({ userId, topics: [...sent] });
		} catch (error) {
			console.warn("User hub was not told what changed.", {
				topics: sent.map((topic) => topic.split(":")[0]),
				message:
					error instanceof Error ? error.message.slice(0, 200) : "unknown",
			});
		}
	};
	// Inside the edge executor (direct) the note goes at once: it is already
	// at a state change, and no timer may be added to an object. In a web
	// request, the first note waits one short window for the rest of its burst.
	if (direct) {
		void send(topics);
		return;
	}
	const waiting = pending.get(userId);
	if (waiting) {
		for (const topic of topics) waiting.add(topic);
		return;
	}
	pending.set(userId, new Set(topics));
	const flush = async () => {
		await new Promise((resolve) => setTimeout(resolve, HUB_NOTE_COALESCE_MS));
		const merged = pending.get(userId);
		pending.delete(userId);
		if (merged?.size) await send([...merged].slice(0, MAX_HUB_NOTE_TOPICS));
	};
	if (!startAfterResponse(flush)) void flush();
}
