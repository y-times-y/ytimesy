import { describe, expect, it } from "vitest";
import {
	pullRequestChecksSummary,
	type SidebarPullRequest,
	sidebarChatStatus,
	sidebarChatStatusLabel,
	sidebarChatUnread,
	sidebarPullRequest,
	sidebarPullRequestChecks,
	workingElapsed,
} from "./sidebar-chat-status";

const pr = (fields: Partial<SidebarPullRequest> = {}): SidebarPullRequest => ({
	number: 42,
	url: "https://github.com/o/r/pull/42",
	state: "open",
	checks: null,
	failedChecks: 0,
	...fields,
});

describe("the one status a sidebar row shows", () => {
	it("puts Asking you before everything else", () => {
		expect(
			sidebarChatStatus({
				running: true,
				waitingOn: "question",
				pr: pr(),
				unread: true,
			}),
		).toEqual({ kind: "asking", waitingOn: "question" });
		expect(sidebarChatStatus({ running: false, waitingOn: "plan" })).toEqual({
			kind: "asking",
			waitingOn: "plan",
		});
	});

	it("shows Working over a failure, a PR or an unread reply", () => {
		expect(
			sidebarChatStatus({
				running: true,
				workingSince: "2026-10-22T10:00:00Z",
				waitingOn: "failed",
				pr: pr(),
				unread: true,
			}),
		).toEqual({ kind: "working", since: "2026-10-22T10:00:00Z" });
		expect(sidebarChatStatus({ running: true })).toEqual({
			kind: "working",
			since: null,
		});
	});

	it("shows a failed last turn over the PR", () => {
		expect(
			sidebarChatStatus({ running: false, waitingOn: "failed", pr: pr() }),
		).toEqual({ kind: "failed" });
	});

	it("shows the PR over an unread reply", () => {
		expect(
			sidebarChatStatus({ running: false, pr: pr(), unread: true }),
		).toEqual({ kind: "pr", pr: pr() });
	});

	it("shows unread, else nothing", () => {
		expect(sidebarChatStatus({ running: false, unread: true })).toEqual({
			kind: "unread",
		});
		expect(sidebarChatStatus({ running: false })).toEqual({ kind: "idle" });
	});
});

describe("status words", () => {
	const now = Date.parse("2026-10-22T10:01:12Z");
	const label = (
		status: Parameters<typeof sidebarChatStatusLabel>[0],
	): string | null => sidebarChatStatusLabel(status, now);

	it("names each state briefly", () => {
		expect(label({ kind: "asking", waitingOn: "question" })).toBe(
			"Asking you a question",
		);
		expect(label({ kind: "working", since: "2026-10-22T10:00:00Z" })).toBe(
			"Working · 1m 12s",
		);
		expect(label({ kind: "working", since: null })).toBe("Working");
		expect(label({ kind: "failed" })).toBe("Last turn failed");
		expect(label({ kind: "unread" })).toBe("New reply");
		expect(label({ kind: "idle" })).toBeNull();
	});

	it("names the PR, its state and its checks", () => {
		expect(label({ kind: "pr", pr: pr({ checks: "passed" }) })).toBe(
			"PR #42 open · checks passed",
		);
		expect(
			label({
				kind: "pr",
				pr: pr({ number: 41, checks: "failed", failedChecks: 1 }),
			}),
		).toBe("PR #41 open · 1 check failed");
		expect(
			label({ kind: "pr", pr: pr({ checks: "failed", failedChecks: 3 }) }),
		).toBe("PR #42 open · 3 checks failed");
		expect(label({ kind: "pr", pr: pr() })).toBe("PR #42 open");
		expect(label({ kind: "pr", pr: pr({ number: 44, state: "draft" }) })).toBe(
			"Draft PR #44",
		);
		expect(label({ kind: "pr", pr: pr({ number: 39, state: "merged" }) })).toBe(
			"PR #39 merged",
		);
		expect(label({ kind: "pr", pr: pr({ number: 40, state: "closed" }) })).toBe(
			"PR #40 closed",
		);
	});

	it("counts working time in seconds, minutes and hours", () => {
		expect(workingElapsed(0, 12_000)).toBe("12s");
		expect(workingElapsed(0, 72_000)).toBe("1m 12s");
		expect(workingElapsed(0, 3_900_000)).toBe("1h 5m");
	});
});

describe("PR state and checks from GitHub", () => {
	const listed = {
		number: 7,
		url: "u",
		draft: false,
		state: "open",
		merged: false,
	};

	it("maps open, draft, merged and closed", () => {
		expect(sidebarPullRequest(listed).state).toBe("open");
		expect(sidebarPullRequest({ ...listed, draft: true }).state).toBe("draft");
		expect(
			sidebarPullRequest({ ...listed, state: "closed", merged: true }).state,
		).toBe("merged");
		expect(sidebarPullRequest({ ...listed, state: "closed" }).state).toBe(
			"closed",
		);
	});

	it("marks checks only once they are known", () => {
		expect(sidebarPullRequestChecks(null)).toBeNull();
		expect(
			sidebarPullRequestChecks({ passed: 0, failed: 0, pending: 0 }),
		).toBeNull();
		expect(
			sidebarPullRequestChecks({ passed: 2, failed: 0, pending: 1 }),
		).toBeNull();
		expect(sidebarPullRequestChecks({ passed: 3, failed: 0, pending: 0 })).toBe(
			"passed",
		);
		expect(sidebarPullRequestChecks({ passed: 1, failed: 1, pending: 1 })).toBe(
			"failed",
		);
		expect(
			pullRequestChecksSummary(["passed", "failed", "pending", "skipped"]),
		).toEqual({ passed: 1, failed: 1, pending: 1 });
	});

	it("keeps the failed count and drops checks once the PR is finished", () => {
		const failing = { passed: 1, failed: 2, pending: 0 };
		expect(sidebarPullRequest({ ...listed, checks: failing })).toMatchObject({
			checks: "failed",
			failedChecks: 2,
		});
		expect(
			sidebarPullRequest({
				...listed,
				state: "closed",
				merged: true,
				checks: failing,
			}),
		).toMatchObject({ checks: null, failedChecks: 0 });
	});
});

describe("unread replies", () => {
	const base = {
		selected: false,
		running: false,
		turnStatus: "completed",
		updatedAt: "2026-10-22T10:00:00Z",
		seen: false,
		seenSinceMs: Date.parse("2026-10-22T09:00:00Z"),
	};

	it("is a completed reply newer than tracking that was not opened", () => {
		expect(sidebarChatUnread(base)).toBe(true);
	});

	it("is read when open, seen, running, failed, or older than tracking", () => {
		expect(sidebarChatUnread({ ...base, selected: true })).toBe(false);
		expect(sidebarChatUnread({ ...base, seen: true })).toBe(false);
		expect(sidebarChatUnread({ ...base, running: true })).toBe(false);
		expect(sidebarChatUnread({ ...base, turnStatus: "failed" })).toBe(false);
		expect(
			sidebarChatUnread({
				...base,
				seenSinceMs: Date.parse("2026-10-22T11:00:00Z"),
			}),
		).toBe(false);
		expect(sidebarChatUnread({ ...base, seenSinceMs: null })).toBe(false);
	});
});

it("marks a chat holding a message for setup, below asking and working", async () => {
	const { sidebarChatStatus, sidebarChatStatusLabel } = await import(
		"./sidebar-chat-status"
	);
	const setup = sidebarChatStatus({ running: false, waitsForSetup: true });
	expect(setup).toEqual({ kind: "setup" });
	expect(sidebarChatStatusLabel(setup)).toBe("Waiting for setup");
	expect(sidebarChatStatus({ running: true, waitsForSetup: true }).kind).toBe(
		"working",
	);
	expect(
		sidebarChatStatus({
			running: false,
			waitsForSetup: true,
			waitingOn: "question",
		}).kind,
	).toBe("asking");
});
