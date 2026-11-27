import { describe, expect, it } from "vitest";
import {
	archiveSummaryLine,
	decideSettledThread,
	HOUR_MS,
	REUSE_CANDIDATE_LIMIT,
	type ReuseThread,
	reuseCandidates,
	type SettledFacts,
	settledFactsFor,
	type SettledExtraFacts,
	settledPolicy,
} from "./y-settled-threads";

const base: SettledFacts = {
	state: "finished",
	settledAgeMs: 30 * HOUR_MS,
	lastUserMessageAgeMs: 30 * HOUR_MS,
	pullRequest: "none",
	work: "none",
	pendingQuestion: false,
};
const decide = (patch: Partial<SettledFacts>, idleHours?: number) =>
	decideSettledThread({ ...base, ...patch }, settledPolicy(idleHours));

describe("decideSettledThread", () => {
	it("archives landed work idle past the window", () => {
		expect(decide({ pullRequest: "merged", work: "landed" })).toMatchObject({
			action: "archive",
			code: "landed",
		});
		expect(decide({ pullRequest: "closed", work: "pushed" }).action).toBe(
			"archive",
		);
		expect(decide({ work: "landed" }).action).toBe("archive");
	});

	it("archives a thread that produced no changes", () => {
		expect(decide({})).toMatchObject({ action: "archive", code: "no-changes" });
	});

	it("keeps a thread idle for less than the window, and honours the setting", () => {
		const recent = { settledAgeMs: 10 * HOUR_MS, lastUserMessageAgeMs: null };
		expect(decide(recent)).toMatchObject({
			action: "keep",
			code: "idle-not-long-enough",
		});
		expect(decide(recent, 8).action).toBe("archive");
	});

	it("keeps while the person conversed recently, even if it settled long ago", () => {
		expect(decide({ lastUserMessageAgeMs: 2 * HOUR_MS })).toMatchObject({
			action: "keep",
		});
		expect(
			decide({ lastUserMessageAgeMs: 2 * HOUR_MS, work: "landed" }).hard,
		).toBe(true);
	});

	it("never archives with unpushed work, at any age", () => {
		for (const age of [1, 30, 24 * 90]) {
			const d = decide({
				work: "unpushed",
				pullRequest: "merged",
				settledAgeMs: age * HOUR_MS,
				lastUserMessageAgeMs: null,
				discard: "obsolete",
			});
			expect(d).toMatchObject({
				action: "keep",
				code: "unpushed-work",
				hard: true,
			});
		}
		expect(decide({ state: "failed", work: "unpushed" }).action).toBe("keep");
	});

	it("never archives with a pending question or a waiting thread", () => {
		expect(decide({ pendingQuestion: true, work: "landed" })).toMatchObject({
			action: "keep",
			code: "needs-person",
			hard: true,
		});
		expect(decide({ state: "waiting" }).action).toBe("keep");
		expect(decide({ state: "working" }).action).toBe("keep");
	});

	it("keeps an open or unreadable pull request", () => {
		expect(decide({ pullRequest: "open", work: "pushed" })).toMatchObject({
			action: "keep",
			code: "open-pull-request",
			hard: true,
		});
		expect(decide({ pullRequest: "unknown", work: "pushed" })).toMatchObject({
			action: "keep",
			code: "pull-request-unknown",
		});
	});

	it("keeps when it cannot tell whether work was pushed", () => {
		expect(decide({ work: "unknown" })).toMatchObject({
			action: "keep",
			code: "work-unknown",
			hard: true,
		});
	});

	it("keeps a pushed branch that was never merged", () => {
		expect(decide({ work: "pushed" })).toMatchObject({
			action: "keep",
			code: "pushed-awaiting-merge",
			hard: true,
		});
	});

	it("archives a failed thread after the retry window, only when nothing is unpushed", () => {
		expect(
			decide({
				state: "failed",
				settledAgeMs: 8 * HOUR_MS,
				lastUserMessageAgeMs: null,
			}),
		).toMatchObject({
			action: "archive",
			code: "failed",
		});
		expect(
			decide({
				state: "failed",
				settledAgeMs: 1 * HOUR_MS,
				lastUserMessageAgeMs: null,
			}).action,
		).toBe("keep");
	});

	it("archives a duplicate or obsolete thread before the 24 h window but not a fresh one", () => {
		const d = decide({
			discard: "duplicate",
			settledAgeMs: 8 * HOUR_MS,
			lastUserMessageAgeMs: null,
		});
		expect(d).toMatchObject({ action: "archive", code: "duplicate" });
		expect(
			decide({
				discard: "obsolete",
				settledAgeMs: HOUR_MS,
				lastUserMessageAgeMs: null,
			}).action,
		).toBe("keep");
	});

	it("a model's discard mark cannot beat an open PR or a pending question", () => {
		expect(decide({ discard: "obsolete", pullRequest: "open" }).action).toBe(
			"keep",
		);
		expect(decide({ discard: "duplicate", pendingQuestion: true }).action).toBe(
			"keep",
		);
	});
});

describe("archiveSummaryLine", () => {
	it("is one line of counts, empty when nothing was archived", () => {
		expect(archiveSummaryLine(0, 3)).toBe("");
		expect(archiveSummaryLine(4, 0)).toBe("Archived 4 settled threads.");
		expect(archiveSummaryLine(1, 2)).toMatch(/^Archived 1 settled thread;/);
	});
});

const thread = (patch: Partial<ReuseThread>): ReuseThread => ({
	id: "t",
	title: "Fix sign-up form validation",
	lastRequest: "validate the email field on the sign-up form",
	areas: ["signup"],
	pullRequest: null,
	state: "finished",
	idleMs: 3 * HOUR_MS,
	workspaceAlive: true,
	itemCount: 80,
	modelId: "m1",
	...patch,
});

describe("reuseCandidates", () => {
	const task = {
		text: "The sign-up form should also validate the password length",
	};

	it("suggests a recent, related, finished thread with a warm machine", () => {
		const [first] = reuseCandidates(task, [thread({ id: "a" })]);
		expect(first?.id).toBe("a");
		expect(first?.hint).toContain("warm machine");
	});

	it("ignores unrelated threads", () => {
		expect(
			reuseCandidates(task, [
				thread({
					id: "x",
					title: "Billing invoices",
					lastRequest: "export invoices",
					areas: ["billing"],
				}),
			]),
		).toEqual([]);
	});

	it("excludes working, waiting, failed, gone-workspace, stale and bloated threads", () => {
		const out = reuseCandidates(task, [
			thread({ id: "w", state: "working" }),
			thread({ id: "q", state: "waiting" }),
			thread({ id: "f", state: "failed" }),
			thread({ id: "g", workspaceAlive: false }),
			thread({ id: "s", idleMs: 100 * HOUR_MS }),
			thread({ id: "b", itemCount: 5000 }),
		]);
		expect(out).toEqual([]);
	});

	it("never suggests reuse for a clean checkout or a different model", () => {
		expect(
			reuseCandidates({ ...task, cleanCheckout: true }, [thread({})]),
		).toEqual([]);
		expect(reuseCandidates({ ...task, modelId: "m2" }, [thread({})])).toEqual(
			[],
		);
		expect(
			reuseCandidates({ ...task, modelId: "m1" }, [thread({})]),
		).toHaveLength(1);
	});

	it("prefers the same pull request, and caps the list", () => {
		const many = Array.from({ length: 6 }, (_, i) =>
			thread({ id: `n${i}`, idleMs: (i + 1) * HOUR_MS }),
		);
		const out = reuseCandidates(
			{ text: "address review on pr:o/r#42 sign-up form" },
			[
				...many,
				thread({
					id: "pr",
					title: "Other",
					lastRequest: "x",
					areas: [],
					pullRequest: "42 https://github.com/o/r/pull/42",
				}),
			],
		);
		expect(out[0]?.id).toBe("pr");
		expect(out).toHaveLength(REUSE_CANDIDATE_LIMIT);
	});
});

describe("settledFactsFor", () => {
	const extra: SettledExtraFacts = {
		lastUserAt: null,
		unpushed: false,
		pendingPush: false,
		prUrl: null,
		mayHaveChanged: false,
	};
	const NOW = 1_000 * HOUR_MS;
	const facts = (
		e: Partial<SettledExtraFacts>,
		prOpen?: boolean | null,
		waitingOn: string | null = null,
	) =>
		settledFactsFor({
			chat: { waitingOn, workingSince: null },
			extra: { ...extra, ...e },
			updatedAt: NOW - 30 * HOUR_MS,
			prOpen,
			now: NOW,
		});

	it("reads unpushed notices and pending push approvals as blockers", () => {
		expect(decideSettledThread(facts({ unpushed: true }))).toMatchObject({
			action: "keep",
			code: "unpushed-work",
		});
		expect(decideSettledThread(facts({ pendingPush: true }))).toMatchObject({
			action: "keep",
			code: "needs-person",
		});
	});

	it("a pull request not checked is unknown, never archivable", () => {
		expect(decideSettledThread(facts({ prUrl: "u" }))).toMatchObject({
			code: "pull-request-unknown",
		});
		expect(decideSettledThread(facts({ prUrl: "u" }, true))).toMatchObject({
			code: "open-pull-request",
		});
		expect(decideSettledThread(facts({ prUrl: "u" }, false)).action).toBe(
			"archive",
		);
	});

	it("changes with no pull request and no push signal are unknown, so kept", () => {
		expect(decideSettledThread(facts({ mayHaveChanged: true }))).toMatchObject({
			action: "keep",
			code: "work-unknown",
		});
		expect(decideSettledThread(facts({})).action).toBe("archive");
	});

	it("maps failed and waiting rows", () => {
		expect(facts({}, undefined, "failed").state).toBe("failed");
		expect(facts({}, undefined, "question").state).toBe("waiting");
	});
});
