import { describe, expect, it } from "vitest";
import { workspacePublicationBranch } from "./publication";
import {
	sidebarChatPrMarkForWorkspace,
	sidebarChatPrNeedFromPullRequest,
} from "./sidebar-pr";

describe("sidebarChatPrNeedFromPullRequest", () => {
	it("hides a clean open pull request", () => {
		expect(
			sidebarChatPrNeedFromPullRequest({
				draft: false,
				state: "open",
				merged: false,
				mergeable: true,
				mergeableState: "clean",
			}),
		).toBeNull();
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

	it("hides a merged pull request", () => {
		expect(
			sidebarChatPrNeedFromPullRequest({
				draft: false,
				state: "closed",
				merged: true,
				mergeable: true,
				mergeableState: "clean",
			}),
		).toBeNull();
	});
});

describe("sidebarChatPrMarkForWorkspace", () => {
	it("only attaches a mark when that workspace branch needs attention", () => {
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
		).toBeNull();
	});
});
