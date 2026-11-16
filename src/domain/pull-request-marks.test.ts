import { describe, expect, it } from "vitest";
import {
	checksCountFrom,
	pullRequestWaitingOnYou,
	reviewMarkFrom,
} from "./pull-request-review";

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

describe("pullRequestWaitingOnYou", () => {
	const you = { login: "riley", avatarUrl: null, bot: false };
	const other = { login: "jules", avatarUrl: null, bot: false };
	const green = { passed: 5, failed: 0, pending: 0 };
	const base = {
		state: "open",
		author: "morgan",
		viewer: "riley",
		review: null,
		checks: green,
	} as const;
	it("counts a review asked of you", () => {
		expect(
			pullRequestWaitingOnYou({
				...base,
				review: { kind: "requested", from: you, you: true },
			}),
		).toBe(true);
	});
	it("does not count a review asked of someone else", () => {
		expect(
			pullRequestWaitingOnYou({
				...base,
				review: { kind: "requested", from: other, you: false },
			}),
		).toBe(false);
	});
	it("counts your own approved pull request once every check passed", () => {
		const mine = {
			...base,
			author: "Riley",
			review: { kind: "approved", by: other } as const,
		};
		expect(pullRequestWaitingOnYou(mine)).toBe(true);
		expect(
			pullRequestWaitingOnYou({
				...mine,
				checks: { passed: 4, failed: 1, pending: 0 },
			}),
		).toBe(false);
		expect(
			pullRequestWaitingOnYou({
				...mine,
				checks: { passed: 4, failed: 0, pending: 1 },
			}),
		).toBe(false);
		expect(pullRequestWaitingOnYou({ ...mine, checks: null })).toBe(false);
	});
	it("never counts someone else's approved pull request, a closed one, or an unknown viewer", () => {
		const approved = { kind: "approved", by: other } as const;
		expect(pullRequestWaitingOnYou({ ...base, review: approved })).toBe(false);
		expect(
			pullRequestWaitingOnYou({
				...base,
				author: "riley",
				state: "merged",
				review: approved,
			}),
		).toBe(false);
		expect(
			pullRequestWaitingOnYou({
				...base,
				author: "riley",
				viewer: null,
				review: approved,
			}),
		).toBe(false);
	});
});
