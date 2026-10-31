import { expect, it } from "vitest";
import {
	githubCommitIdentity,
	UNATTRIBUTED_COMMIT_NOTICE,
} from "./github-commit-identity";

it("uses the GitHub profile name and email when both are present", () => {
	expect(
		githubCommitIdentity({
			login: "het",
			id: 7,
			name: "Het Patel",
			email: "het@example.test",
		}),
	).toEqual({ name: "Het Patel", email: "het@example.test" });
});

it("uses GitHub's noreply address when the profile email is private", () => {
	expect(
		githubCommitIdentity({
			login: "het",
			id: 7,
			name: "  ",
			email: null,
		}),
	).toEqual({
		name: "het",
		email: "7+het@users.noreply.github.com",
	});
});

it("does not invent an author when the GitHub login is missing", () => {
	expect(
		githubCommitIdentity({
			login: null,
			id: 7,
			name: "Het",
			email: "het@example.test",
		}),
	).toBeNull();
	expect(
		githubCommitIdentity({ login: "het", id: null, name: "Het", email: null }),
	).toBeNull();
	expect(UNATTRIBUTED_COMMIT_NOTICE).toMatch(/ytimesy author/);
	expect(UNATTRIBUTED_COMMIT_NOTICE).toMatch(/login/);
});
