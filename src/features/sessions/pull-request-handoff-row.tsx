import { GitPullRequest, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import {
	PULL_REQUEST_HANDOFF_STALE_MS,
	visiblePullRequestHandoff,
} from "#/domain/pull-request-handoff-item";
import type { NoticeSessionItem } from "#/domain/session-item";
import { pullRequestReference } from "./agent-references";

/** The attributes that make a link open the in-app pull request page on a plain click. */
export function pullRequestChipAttributes(url: string) {
	const reference = pullRequestReference(url);
	return reference
		? {
				"data-reference": "pull-request",
				"data-ref": `${reference.owner}/${reference.repo}#${reference.number}`,
			}
		: {};
}

/**
 * A done turn's pull request handoff under its answer: "Opening pull
 * request…" while its branch is pushed, then the pull request's link.
 */
export function PullRequestHandoffRow({
	item,
}: {
	readonly item: NoticeSessionItem;
}) {
	const now = useStaleClock(item);
	const state = item.pullRequest
		? visiblePullRequestHandoff(item.pullRequest, false, now)
		: null;
	if (!state) return null;
	return (
		<div
			className="session-activity session-system-notice"
			data-kind="pull-request"
			data-state={state.state}
			role="status"
		>
			<p>
				{state.state === "opening" ? (
					<LoaderCircle
						size={14}
						className="workspace-status-spin"
						aria-hidden="true"
					/>
				) : (
					<GitPullRequest size={14} aria-hidden="true" />
				)}
				{state.state === "opened" ? (
					<a
						className="session-activity-title"
						// Opens the in-app pull request page when the project has the repository (agent-reference-chips.tsx).
						{...pullRequestChipAttributes(state.url)}
						href={state.url}
						target="_blank"
						rel="noreferrer"
					>
						{item.message}
					</a>
				) : (
					<span className="session-activity-title">{item.message}</span>
				)}
			</p>
		</div>
	);
}

/** The time, re-read once an opening handoff turns stale so it stops showing. */
function useStaleClock(item: NoticeSessionItem) {
	const [now, setNow] = useState(() => Date.now());
	const since =
		item.pullRequest?.state === "opening" ? item.pullRequest.since : null;
	useEffect(() => {
		if (since === null) return;
		const left = since + PULL_REQUEST_HANDOFF_STALE_MS - Date.now();
		if (left <= 0) return;
		const timer = window.setTimeout(() => setNow(Date.now()), left + 50);
		return () => window.clearTimeout(timer);
	}, [since]);
	return now;
}
