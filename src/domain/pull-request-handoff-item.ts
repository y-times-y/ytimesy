import { SessionItemId } from "./ids";
import type {
	NoticeSessionItem,
	PullRequestHandoffState,
	SessionItem,
} from "./session-item";

/**
 * A root chat's turn is marked done as soon as its changes are committed;
 * pushing its branch and opening (or updating) its draft pull request
 * continue right after. This item says so in the chat meanwhile ("Opening
 * pull request…") and is replaced with the pull request's link, or removed
 * when nothing reached a pull request, once GitHub answers.
 */
export const PULL_REQUEST_HANDOFF_ITEM_SUFFIX = ":pull-request";

/**
 * How long an unanswered handoff is shown as still opening. The handoff
 * itself takes seconds; one older than this was cut off (a restart), and
 * the next turn pushes its commits.
 */
export const PULL_REQUEST_HANDOFF_STALE_MS = 2 * 60_000;

export const OPENING_PULL_REQUEST_TEXT = "Opening pull request…";

export function pullRequestHandoffItemId(turnId: string) {
	return SessionItemId(`${turnId}${PULL_REQUEST_HANDOFF_ITEM_SUFFIX}`);
}

export function openingPullRequestItem(
	turnId: string,
	now: number,
): NoticeSessionItem {
	return {
		kind: "notice",
		id: pullRequestHandoffItemId(turnId),
		message: OPENING_PULL_REQUEST_TEXT,
		pullRequest: { state: "opening", since: now },
	};
}

/** The handoff's answer: the pull request's link, or null when none was opened or updated. */
export function openedPullRequestItem(
	turnId: string,
	pull:
		| {
				readonly number: number;
				readonly url: string;
				readonly draft: boolean;
				readonly created: boolean;
		  }
		| undefined,
): NoticeSessionItem | null {
	if (!pull) return null;
	const name = `${pull.draft ? "draft PR" : "PR"} #${pull.number}`;
	return {
		kind: "notice",
		id: pullRequestHandoffItemId(turnId),
		message: pull.created ? `Opened ${name}` : `Pushed to ${name}`,
		pullRequest: {
			state: "opened",
			number: pull.number,
			url: pull.url,
			draft: pull.draft,
			created: pull.created,
		},
	};
}

/**
 * The newest turn's handoff as the chat shows it: still opening (not while
 * a turn runs, nor once stale), or the pull request it reached. Null when
 * the newest turn has none.
 */
export function latestPullRequestHandoff(
	items: readonly SessionItem[],
	turnRunning: boolean,
	now: number,
): PullRequestHandoffState | null {
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item.kind === "userMessage") return null;
		if (item.kind !== "notice" || !item.pullRequest) continue;
		return visiblePullRequestHandoff(item.pullRequest, turnRunning, now);
	}
	return null;
}

/** An opening handoff shown as such: not while a turn runs, nor once stale. */
export function visiblePullRequestHandoff(
	state: PullRequestHandoffState,
	turnRunning: boolean,
	now: number,
): PullRequestHandoffState | null {
	if (state.state === "opened") return state;
	if (turnRunning || now - state.since > PULL_REQUEST_HANDOFF_STALE_MS)
		return null;
	return state;
}
