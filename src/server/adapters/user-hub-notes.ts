import { userHubEnabledFor } from "#/domain/user-hub";
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
	const work = async () => {
		try {
			if (direct) await direct(userId, topics);
			else await postUserHubNote({ userId, topics: [...topics] });
		} catch (error) {
			console.warn("User hub was not told what changed.", {
				topics: topics.map((topic) => topic.split(":")[0]),
				message:
					error instanceof Error ? error.message.slice(0, 200) : "unknown",
			});
		}
	};
	if (!startAfterResponse(work)) void work();
}
