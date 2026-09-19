import { expect, it } from "vitest";
import {
	commitCoAuthorTrailer,
	publicationBlockedReason,
	publicationCoAuthor,
	publicationCommitAuthor,
	publicationHeadBranch,
	publicationHumanAuthor,
	publicationSessionBlockedReason,
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
	expect(
		publicationWorkspaceBlockedReason({
			status: "ready",
			providerRef: null,
			templateSnapshotId: "sh-template",
		}),
	).toBeNull();
});

it("does not publish from the unused template", () => {
	expect(publicationSessionBlockedReason("vm-agent")).toBeNull();
	expect(publicationSessionBlockedReason(null)).toMatch(/Connect an agent/);
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

it("names the commit after the GitHub App bot and keeps the user as co-author", () => {
	const bot = {
		name: "ytimesy-cloud[bot]",
		email: "328807657+ytimesy-cloud[bot]@users.noreply.github.com",
	};
	expect(
		publicationCommitAuthor({
			name: "Het",
			email: "het@example.test",
			bot,
		}),
	).toEqual(bot);
	expect(
		publicationCoAuthor({
			author: bot,
			human: publicationHumanAuthor({
				name: "Het",
				email: "het@example.test",
			}),
		}),
	).toEqual({ name: "Het", email: "het@example.test" });
	expect(
		commitCoAuthorTrailer({ name: "Het", email: "het@example.test" }),
	).toBe("Co-authored-by: Het <het@example.test>");
	expect(
		publicationCommitAuthor({ name: "Het", email: "het@example.test" }),
	).toEqual({ name: "Het", email: "het@example.test" });
	expect(publicationCommitAuthor({ name: "  ", email: null })).toEqual({
		name: "noreply",
		email: "noreply@ytimesy.com",
	});
});
