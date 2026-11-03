import { expect, it } from "vitest";
import { SessionItemId } from "./ids";
import {
	latestPullRequestHandoff,
	OPENING_PULL_REQUEST_TEXT,
	openedPullRequestItem,
	openingPullRequestItem,
	PULL_REQUEST_HANDOFF_STALE_MS,
} from "./pull-request-handoff-item";
import type { SessionItem } from "./session-item";
import { progressStreamWanted } from "./session-progress";

const user: SessionItem = {
	kind: "userMessage",
	id: SessionItemId("u1"),
	text: "Fix it",
};
const answer: SessionItem = {
	kind: "agentMessage",
	id: SessionItemId("a1"),
	text: "Done.",
};
const pull = {
	number: 4,
	url: "https://github.com/o/r/pull/4",
	draft: true,
	created: true,
};

it("says the pull request is opening, then links it", () => {
	const opening = openingPullRequestItem("turn", 1_000);
	expect(opening).toMatchObject({
		id: "turn:pull-request",
		message: OPENING_PULL_REQUEST_TEXT,
		pullRequest: { state: "opening", since: 1_000 },
	});
	expect(
		latestPullRequestHandoff([user, answer, opening], false, 2_000),
	).toEqual({ state: "opening", since: 1_000 });
	const opened = openedPullRequestItem("turn", pull);
	expect(opened?.message).toBe("Opened draft PR #4");
	expect(
		openedPullRequestItem("turn", { ...pull, created: false, draft: false })
			?.message,
	).toBe("Pushed to PR #4");
	expect(
		latestPullRequestHandoff([user, answer, opened as SessionItem], false, 0),
	).toMatchObject({ state: "opened", url: pull.url });
	expect(openedPullRequestItem("turn", undefined)).toBeNull();
});

it("stops showing an opening handoff once stale, a turn runs, or a newer message was sent", () => {
	const opening = openingPullRequestItem("turn", 1_000);
	const items = [user, answer, opening];
	expect(
		latestPullRequestHandoff(
			items,
			false,
			1_001 + PULL_REQUEST_HANDOFF_STALE_MS,
		),
	).toBeNull();
	expect(latestPullRequestHandoff(items, true, 1_001)).toBeNull();
	expect(
		latestPullRequestHandoff(
			[...items, { ...user, id: SessionItemId("u2") }],
			false,
			1_001,
		),
	).toBeNull();
});

it("keeps the progress stream open while a done turn opens its pull request", () => {
	const idle = {
		turnRunning: false,
		helpersWorking: false,
		watchingForWake: false,
	};
	expect(progressStreamWanted(idle)).toBe(false);
	expect(progressStreamWanted({ ...idle, openingPullRequest: true })).toBe(
		true,
	);
});
