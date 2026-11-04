import type { ChatWaitingOn } from "./sidebar-chats";

/** Where a chat's pull request stands, as the sidebar shows it. */
export type SidebarPullRequest = {
	readonly number: number;
	readonly url: string;
	readonly state: "open" | "draft" | "merged" | "closed";
	/** Known check results of an open or draft PR; null while pending or unknown. */
	readonly checks: "passed" | "failed" | null;
	/** How many checks failed, when `checks` is "failed". */
	readonly failedChecks: number;
	/** Whether GitHub could merge an open PR, when it had worked that out. */
	readonly merge?: SidebarPullRequestMerge | null;
};

export type SidebarPullRequestMerge = "ready" | "conflict" | "blocked";

/** GitHub's merge answer for an open PR; null while it has not computed one. */
export function sidebarPullRequestMerge(pr: {
	readonly mergeable?: boolean | null;
	readonly mergeableState?: string | null;
}): SidebarPullRequestMerge | null {
	const state = pr.mergeableState?.trim().toLowerCase() ?? "";
	if (pr.mergeable === false || state === "dirty") return "conflict";
	if (state === "blocked" || state === "behind") return "blocked";
	if (pr.mergeable === true && state === "clean") return "ready";
	return null;
}

/** The one status a sidebar row shows on its right, by priority. */
export type SidebarChatStatus =
	| {
			readonly kind: "asking";
			readonly waitingOn: Exclude<ChatWaitingOn, "failed">;
	  }
	| { readonly kind: "working"; readonly since: string | null }
	/** A message waits in the chat for the project's environment. */
	| { readonly kind: "setup" }
	| { readonly kind: "failed" }
	| { readonly kind: "pr"; readonly pr: SidebarPullRequest }
	| { readonly kind: "unread" }
	| { readonly kind: "idle" };

/**
 * Asking you, then Working, then a message waiting for setup, then a failed
 * last turn, then the PR, then an unread reply; otherwise nothing (the row
 * shows its relative time).
 */
export function sidebarChatStatus(input: {
	readonly running: boolean;
	/** A message waits in the chat for the project's environment. */
	readonly waitsForSetup?: boolean;
	/** When Main or a helper started its active turn, if known. */
	readonly workingSince?: string | null;
	readonly waitingOn?: ChatWaitingOn | null;
	readonly pr?: SidebarPullRequest | null;
	readonly unread?: boolean;
}): SidebarChatStatus {
	const waitingOn = input.waitingOn ?? null;
	if (waitingOn && waitingOn !== "failed") return { kind: "asking", waitingOn };
	if (input.running)
		return { kind: "working", since: input.workingSince ?? null };
	if (input.waitsForSetup) return { kind: "setup" };
	if (waitingOn === "failed") return { kind: "failed" };
	if (input.pr) return { kind: "pr", pr: input.pr };
	if (input.unread) return { kind: "unread" };
	return { kind: "idle" };
}

/** "12s", "1m 12s", "1h 5m". */
export function workingElapsed(sinceMs: number, nowMs: number): string {
	const seconds = Math.max(0, Math.floor((nowMs - sinceMs) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The status in words, for the row's tooltip and screen readers; null when idle. */
export function sidebarChatStatusLabel(
	status: SidebarChatStatus,
	nowMs = Date.now(),
): string | null {
	switch (status.kind) {
		case "asking":
			return {
				question: "Asking you a question",
				plan: "Waiting for your approval",
				paused: "Waiting for your approval",
				secret: "Needs a secret",
				push: "Waiting for your approval to push",
			}[status.waitingOn];
		case "working": {
			const since = status.since ? Date.parse(status.since) : Number.NaN;
			return Number.isFinite(since)
				? `Working · ${workingElapsed(since, nowMs)}`
				: "Working";
		}
		case "setup":
			return "Waiting for setup";
		case "failed":
			return "Last turn failed";
		case "pr":
			return pullRequestLabel(status.pr);
		case "unread":
			return "New reply";
		case "idle":
			return null;
	}
}

function pullRequestLabel(pr: SidebarPullRequest): string {
	if (pr.state === "merged") return `PR #${pr.number} merged`;
	if (pr.state === "closed") return `PR #${pr.number} closed`;
	const name =
		pr.state === "draft" ? `Draft PR #${pr.number}` : `PR #${pr.number} open`;
	if (pr.checks === "passed") return `${name} · checks passed`;
	if (pr.checks === "failed") {
		const count = Math.max(1, pr.failedChecks);
		return `${name} · ${count} ${count === 1 ? "check" : "checks"} failed`;
	}
	return name;
}

/** Counts of one PR head's latest check runs and commit statuses. */
export type PullRequestChecksSummary = {
	readonly passed: number;
	readonly failed: number;
	readonly pending: number;
};

export function pullRequestChecksSummary(
	states: readonly ("passed" | "failed" | "pending" | "skipped")[],
): PullRequestChecksSummary {
	return {
		passed: states.filter((state) => state === "passed").length,
		failed: states.filter((state) => state === "failed").length,
		pending: states.filter((state) => state === "pending").length,
	};
}

/** A cross once any check failed; a check once all finished and passed; else nothing. */
export function sidebarPullRequestChecks(
	summary: PullRequestChecksSummary | null | undefined,
): SidebarPullRequest["checks"] {
	if (!summary) return null;
	if (summary.failed > 0) return "failed";
	if (summary.pending > 0 || summary.passed === 0) return null;
	return "passed";
}

export function sidebarPullRequest(pr: {
	readonly number: number;
	readonly url: string;
	readonly draft: boolean;
	readonly state: string;
	readonly merged: boolean;
	readonly mergeable?: boolean | null;
	readonly mergeableState?: string | null;
	readonly checks?: PullRequestChecksSummary | null;
}): SidebarPullRequest {
	const state = pr.merged
		? "merged"
		: pr.state === "closed"
			? "closed"
			: pr.draft
				? "draft"
				: "open";
	const finished = state === "merged" || state === "closed";
	const checks = finished ? null : sidebarPullRequestChecks(pr.checks);
	const merge = finished ? null : sidebarPullRequestMerge(pr);
	return {
		number: pr.number,
		url: pr.url,
		state,
		checks,
		failedChecks: checks === "failed" ? (pr.checks?.failed ?? 0) : 0,
		...(merge ? { merge } : {}),
	};
}

/**
 * A completed reply the user has not opened: not the open chat, not seen
 * under its current key, and newer than when this browser started tracking.
 */
export function sidebarChatUnread(input: {
	readonly selected: boolean;
	readonly running: boolean;
	readonly turnStatus?: string;
	readonly updatedAt?: string | null;
	readonly seen: boolean;
	readonly seenSinceMs: number | null;
}): boolean {
	if (input.selected || input.running || input.seen) return false;
	if (input.turnStatus !== "completed") return false;
	if (input.seenSinceMs === null) return false;
	const updated = input.updatedAt ? Date.parse(input.updatedAt) : Number.NaN;
	return Number.isFinite(updated) && updated > input.seenSinceMs;
}
