import { describe, expect, it } from "vitest";
import { workspacePublicationBranch } from "./publication";
import {
	sidebarChatPrMarkForWorkspace,
	sidebarChatPrNeedFromPullRequest,
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
