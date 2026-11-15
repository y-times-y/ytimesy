import { describe, expect, it } from "vitest";
import { checksCountFrom, reviewMarkFrom } from "./pull-request-review";

const person = (login: string) => ({ login, avatarUrl: null, bot: false });

describe("the review mark of a pull request", () => {
	it("shows who approved", () => {
		expect(
			reviewMarkFrom({
				decisions: [{ state: "APPROVED", person: person("mk") }],
				requested: [],
				viewer: "ada",
			}),
		).toEqual({ kind: "approved", by: person("mk") });
	});

	it("puts a request for changes above an approval", () => {
		const mark = reviewMarkFrom({
			decisions: [
				{ state: "APPROVED", person: person("mk") },
				{ state: "CHANGES_REQUESTED", person: person("ra") },
			],
			requested: [],
			viewer: null,
		});
		expect(mark).toEqual({ kind: "changes", by: person("ra") });
	});

	it("shows a review asked of the signed-in user as theirs, whoever else was asked", () => {
		const mark = reviewMarkFrom({
			decisions: [],
			requested: [person("mk"), person("Ada")],
			viewer: "ada",
		});
		expect(mark).toEqual({ kind: "requested", from: person("Ada"), you: true });
	});

	it("shows the first person asked when it was not the user", () => {
		expect(
			reviewMarkFrom({
				decisions: [],
				requested: [person("mk")],
				viewer: "ada",
			}),
		).toEqual({ kind: "requested", from: person("mk"), you: false });
	});

	it("shows nothing when nobody reviewed and nobody was asked", () => {
		expect(
			reviewMarkFrom({ decisions: [], requested: [], viewer: "ada" }),
		).toBeNull();
	});

	it("ignores comment-only and dismissed reviews", () => {
		expect(
			reviewMarkFrom({
				decisions: [
					{ state: "COMMENTED", person: person("mk") },
					{ state: "DISMISSED", person: person("ra") },
				],
				requested: [],
				viewer: null,
			}),
		).toBeNull();
	});
});

describe("check counts", () => {
	it("counts passed, failing and running results", () => {
		expect(
			checksCountFrom([
				{ status: "completed", conclusion: "success" },
				{ status: "completed", conclusion: "success" },
				{ status: "completed", conclusion: "failure" },
				{ status: "in_progress", conclusion: null },
				{ state: "success" },
				{ state: "pending" },
			]),
		).toEqual({ passed: 3, failed: 1, pending: 2 });
	});

	it("is null when there are no checks, and skipped ones count as none", () => {
		expect(checksCountFrom([])).toBeNull();
		expect(
			checksCountFrom([{ status: "completed", conclusion: "skipped" }]),
		).toEqual({ passed: 0, failed: 0, pending: 0 });
	});
});
