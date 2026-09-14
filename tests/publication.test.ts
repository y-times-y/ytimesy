import { expect, it } from "vitest";
import { publicationBlockedReason } from "../src/domain/publication";

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
