import { expect, it } from "vitest";
import {
	publicationBlockedReason,
	publicationCommitAuthor,
	publicationHeadBranch,
	publicationWorkspaceBlockedReason,
	workspacePublicationBranch,
} from "../src/domain/publication";

it("blocks publishing a branch onto itself", () => {
	expect(
		publicationBlockedReason({ head: "master", base: "master", aheadBy: 3 }),
	).toMatch(/base branch/);
});

it("blocks publishing when the branch is not ahead", () => {
	expect(
		publicationBlockedReason({
			head: "feature",
			base: "master",
			aheadBy: 0,
		}),
	).toMatch(/no commits ahead/);
});

it("allows an explicit publish when the branch is ahead", () => {
	expect(
		publicationBlockedReason({
			head: "feature",
			base: "master",
			aheadBy: 2,
		}),
	).toBeNull();
});

it("blocks publish until a prepared workspace exists", () => {
	expect(publicationWorkspaceBlockedReason(null)).toMatch(
		/Prepare a workspace/,
	);
	expect(
		publicationWorkspaceBlockedReason({
			status: "installing",
			providerRef: "vm-1",
		}),
	).toMatch(/Wait for workspace preparation/);
	expect(
		publicationWorkspaceBlockedReason({
			status: "ready",
			providerRef: "vm-1",
		}),
	).toBeNull();
});

it("opens a workspace branch when the selected branch is the default", () => {
	const workspaceId = "11111111-2222-4333-8444-555555555555";
	expect(workspacePublicationBranch(workspaceId)).toBe("ytimesy-111111112222");
	expect(
		publicationHeadBranch({
			selectedBranch: "master",
			defaultBranch: "master",
			workspaceId,
		}),
	).toBe("ytimesy-111111112222");
	expect(
		publicationHeadBranch({
			selectedBranch: "feature",
			defaultBranch: "master",
			workspaceId,
		}),
	).toBe("feature");
});

it("names the commit after the signed-in user", () => {
	expect(
		publicationCommitAuthor({ name: "Het", email: "het@example.test" }),
	).toEqual({ name: "Het", email: "het@example.test" });
	expect(publicationCommitAuthor({ name: "  ", email: null })).toEqual({
		name: "noreply",
		email: "noreply@ytimesy.com",
	});
});
