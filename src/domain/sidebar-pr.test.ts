import { describe, expect, it } from "vitest";
import { workspacePublicationBranch } from "./publication";
import {
	mergeAnswerPending,
	pullRequestPanelRepository,
	pullRequestsAcrossRepositories,
	savedListedPullRequest,
	sidebarChatPrMarkForWorkspace,
	sidebarChatPrNeedFromPullRequest,
	sidebarChatPrNeedLabel,
} from "./sidebar-pr";

describe("sidebarChatPrNeedFromPullRequest", () => {
	it.each([
		[null, null],
		[true, "unknown"],
		[null, "clean"],
		[true, "has_hooks"],
	] as const)(
		"does not infer readiness from %s / %s",
		(mergeable, mergeableState) => {
			expect(
				sidebarChatPrNeedFromPullRequest({
					draft: false,
					state: "open",
					merged: false,
					mergeable,
					mergeableState,
				}),
			).toBe("pending");
		},
	);
	it("shows no failure for an unstable pull request whose checks did not fail", () => {
		const unstable = {
			state: "open",
			merged: false,
			mergeable: true,
			mergeableState: "unstable",
		} as const;
		// No CI: only other Apps' queued suites, no check runs or statuses.
		const none = { passed: 0, failed: 0, pending: 0 };
		expect(
			sidebarChatPrNeedFromPullRequest({
				...unstable,
				draft: true,
				checks: none,
			}),
		).toBe("draft");
		expect(
			sidebarChatPrNeedFromPullRequest({
				...unstable,
				draft: false,
				checks: none,
			}),
		).toBe("ready");
		expect(
			sidebarChatPrNeedFromPullRequest({
				...unstable,
				draft: false,
				checks: { passed: 1, failed: 0, pending: 1 },
			}),
		).toBe("pending");
		expect(
			sidebarChatPrNeedFromPullRequest({
				...unstable,
				draft: false,
				checks: { passed: 0, failed: 1, pending: 0 },
			}),
		).toBe("checks_failed");
		// A saved mark without check counts keeps what it said.
		expect(
			sidebarChatPrNeedFromPullRequest({ ...unstable, draft: false }),
		).toBe("checks_failed");
	});
	it("does not mark a draft with a clean merge as ready", () => {
		expect(
			sidebarChatPrNeedFromPullRequest({
				draft: true,
				state: "open",
				merged: false,
				mergeable: true,
				mergeableState: "clean",
			}),
		).toBe("draft");
	});
	it("marks a clean open pull request ready", () => {
		expect(
			sidebarChatPrNeedFromPullRequest({
				draft: false,
				state: "open",
				merged: false,
				mergeable: true,
				mergeableState: "clean",
			}),
		).toBe("ready");
	});

	it("marks merge conflicts, blocked reviews, and failed checks", () => {
		expect(
			sidebarChatPrNeedFromPullRequest({
				draft: false,
				state: "open",
				merged: false,
				mergeable: false,
				mergeableState: "dirty",
			}),
		).toBe("conflict");
		expect(
			sidebarChatPrNeedFromPullRequest({
				draft: false,
				state: "open",
				merged: false,
				mergeable: true,
				mergeableState: "blocked",
			}),
		).toBe("blocked");
		expect(
			sidebarChatPrNeedFromPullRequest({
				draft: false,
				state: "open",
				merged: false,
				mergeable: true,
				mergeableState: "unstable",
			}),
		).toBe("checks_failed");
	});

	it("marks a draft or closed unmerged pull request", () => {
		expect(
			sidebarChatPrNeedFromPullRequest({
				draft: true,
				state: "open",
				merged: false,
				mergeable: true,
				mergeableState: "draft",
			}),
		).toBe("draft");
		expect(
			sidebarChatPrNeedFromPullRequest({
				draft: false,
				state: "closed",
				merged: false,
				mergeable: false,
				mergeableState: "dirty",
			}),
		).toBe("closed");
	});

	it("keeps a merged pull request visible", () => {
		expect(
			sidebarChatPrNeedFromPullRequest({
				draft: false,
				state: "closed",
				merged: true,
				mergeable: true,
				mergeableState: "clean",
			}),
		).toBe("merged");
	});
});

describe("sidebarChatPrMarkForWorkspace", () => {
	it("matches the chat's recorded branch before its legacy workspace branch", () => {
		expect(
			sidebarChatPrMarkForWorkspace({
				workspaceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
				workingBranch: "ytimesy/fix-parser-abcd",
				pullRequests: [
					{
						number: 1,
						url: "https://github.com/owner/repo/pull/1",
						head: "ytimesy/fix-parser-abcd",
						draft: true,
						state: "open",
						merged: false,
						mergeable: null,
						mergeableState: null,
					},
				],
			})?.need,
		).toBe("draft");
	});
	it("attaches both attention and ready marks to the matching workspace", () => {
		const workspaceId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
		const head = workspacePublicationBranch(workspaceId);
		expect(
			sidebarChatPrMarkForWorkspace({
				workspaceId,
				pullRequests: [
					{
						number: 12,
						url: "https://github.com/y-times-y/ytimesy/pull/12",
						head,
						draft: false,
						state: "open",
						merged: false,
						mergeable: false,
						mergeableState: "dirty",
					},
				],
			}),
		).toEqual({
			need: "conflict",
			url: "https://github.com/y-times-y/ytimesy/pull/12",
			label: "Has merge conflicts",
			pr: {
				number: 12,
				url: "https://github.com/y-times-y/ytimesy/pull/12",
				state: "open",
				checks: null,
				failedChecks: 0,
				merge: "conflict",
			},
		});
		expect(
			sidebarChatPrMarkForWorkspace({
				workspaceId,
				pullRequests: [
					{
						number: 12,
						url: "https://github.com/y-times-y/ytimesy/pull/12",
						head,
						draft: false,
						state: "open",
						merged: false,
						mergeable: true,
						mergeableState: "clean",
					},
				],
			}),
		).toMatchObject({ need: "ready", label: "Ready to merge" });
	});
});

describe("pull requests across a project's repositories", () => {
	const primary = { installationId: 1, repositoryId: 10, fullName: "o/app" };
	const secondary = { installationId: 1, repositoryId: 20, fullName: "o/api" };
	const pr = (number: number, head: string) => ({
		number,
		url: `https://github.com/o/x/pull/${number}`,
		head,
		draft: true,
		state: "open",
		merged: false,
		mergeable: null,
		mergeableState: null,
	});

	it("marks a chat whose PR the agent opened in a secondary repository", () => {
		const head = workspacePublicationBranch("ws-1");
		const listed = pullRequestsAcrossRepositories([
			{ repository: primary, pullRequests: [pr(1, "other")] },
			{ repository: secondary, pullRequests: [pr(7, head)] },
		]);
		expect(
			sidebarChatPrMarkForWorkspace({
				workspaceId: "ws-1",
				pullRequests: listed,
			}),
		).toMatchObject({ url: "https://github.com/o/x/pull/7" });
		const chatPr = listed.find((row) => row.head === head);
		expect(
			pullRequestPanelRepository({
				repositories: [primary, secondary],
				chatPullRequest: chatPr,
			}),
		).toEqual({ installationId: 1, repositoryId: 20, number: 7 });
	});

	it("opens the primary repository when the chat has no PR", () => {
		expect(pullRequestsAcrossRepositories([{ repository: primary }])).toEqual(
			[],
		);
		expect(
			pullRequestPanelRepository({ repositories: [primary, secondary] }),
		).toEqual({ installationId: 1, repositoryId: 10 });
		expect(pullRequestPanelRepository({ repositories: [] })).toBeUndefined();
	});
});

describe("savedListedPullRequest", () => {
	const saved = {
		number: 7,
		url: "https://github.com/o/r/pull/7",
		checks: null,
		failedChecks: 0,
	} as const;
	const label = (
		state: "open" | "draft" | "merged" | "closed",
		checks: "failed" | null = null,
	) =>
		sidebarChatPrNeedLabel(
			sidebarChatPrNeedFromPullRequest(
				savedListedPullRequest({ ...saved, state, checks }, "ytimesy/a"),
			),
		);
	it("reads as the PR the sidebar saved until the live list is read", () => {
		expect(
			savedListedPullRequest({ ...saved, state: "open" }, "ytimesy/a"),
		).toMatchObject({
			number: 7,
			head: "ytimesy/a",
		});
		expect(label("draft")).toBe("Draft pull request");
		expect(label("merged")).toBe("Pull request merged");
		expect(label("closed")).toBe("Pull request closed");
		expect(label("open", "failed")).toBe("Checks failed");
		expect(label("open")).toBe("Merge readiness not confirmed");
	});
});

describe("saved merge answers", () => {
	const saved = {
		number: 9,
		url: "https://github.com/o/r/pull/9",
		state: "open",
		checks: null,
		failedChecks: 0,
	} as const;
	it("paints the merge answer the browser saved, not 'not confirmed'", () => {
		const need = (merge?: "ready" | "conflict" | "blocked") =>
			sidebarChatPrNeedFromPullRequest(
				savedListedPullRequest({ ...saved, merge }, "ytimesy/a"),
			);
		expect(need("ready")).toBe("ready");
		expect(need("conflict")).toBe("conflict");
		expect(need("blocked")).toBe("blocked");
		expect(need()).toBe("pending");
	});
	it("asks GitHub again only while an open PR's answer is pending", () => {
		const pr = {
			number: 9,
			url: saved.url,
			head: "ytimesy/a",
			draft: false,
			state: "open",
			merged: false,
			mergeable: null,
			mergeableState: "unknown",
		};
		expect(mergeAnswerPending(pr)).toBe(true);
		expect(
			mergeAnswerPending({ ...pr, mergeable: true, mergeableState: "clean" }),
		).toBe(false);
		expect(mergeAnswerPending({ ...pr, draft: true })).toBe(false);
	});
});
