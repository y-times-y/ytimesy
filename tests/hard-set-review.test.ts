import { describe, expect, it } from "vitest";
import {
	type HardSetReviewRecord,
	type HardSetReviewRound,
	reviewLoopReport,
} from "../scripts/hard-set/review-report";

const snapshot = {
	cwd: "/app",
	tree: "t",
	indexTree: "i",
	head: "h",
	ref: "r",
};

const round = (extra: Partial<HardSetReviewRound>): HardSetReviewRound => ({
	n: 1,
	verdict: "fail",
	timedOut: false,
	truncated: false,
	findings: 2,
	findingTexts: [],
	decision: "fix",
	checkerTokens: 1000,
	checkerCostUsd: 0.01,
	checkMinutes: 2.5,
	fixTokens: 500,
	fixCostUsd: 0.005,
	fixMinutes: 1.2,
	fixed: 1,
	rejected: 1,
	unanswered: 0,
	tree: "t1",
	snapshot,
	sameAsFinal: false,
	gradeName: "artifacts-r1",
	graderReward: 0,
	graderPassed: false,
	...extra,
});

const loop = (
	rounds: HardSetReviewRound[],
	extra: Partial<HardSetReviewRecord> = {},
): HardSetReviewRecord => ({
	phase: "done",
	outcome: "pass",
	note: null,
	rounds,
	extraTokens: 1000,
	extraCostUsd: 0.01,
	checkers: rounds.length,
	finalTree: "t2",
	branch: "",
	attemptGrading: "final",
	notes: [],
	...extra,
});

describe("hard set review report", () => {
	it("shows rounds, the checked tree's grade and fail -> fix -> pass", () => {
		const lines = reviewLoopReport([
			{
				task: "mvcc",
				attempt: "1",
				status: "final",
				passed: true,
				reviewLoop: loop([
					round({}),
					round({
						n: 2,
						verdict: "pass",
						findings: 0,
						decision: "pass",
						sameAsFinal: true,
						graderPassed: true,
						gradeName: null,
					}),
				]),
			},
			{
				task: "clip",
				attempt: "1",
				status: "final",
				passed: false,
				reviewLoop: loop(
					[
						round({
							verdict: "unsure",
							findings: 0,
							decision: "no-findings",
							sameAsFinal: true,
						}),
					],
					{ outcome: "no-findings" },
				),
			},
			{
				task: "heat",
				attempt: "1",
				status: "final",
				passed: true,
				reviewLoop: loop([], {
					outcome: "time",
					note: "not enough time left for a check and a fix",
				}),
			},
			{ task: "plain", attempt: "1", status: "final", passed: true },
		]);
		expect(lines[2]).toBe(
			"- mvcc.1: R1 fail(2)->fail 2.5m fix 1.2m fixed 1 rejected 1, R2 pass->PASS 2.5m; pass; final PASS",
		);
		expect(lines[3]).toBe(
			"- clip.1: R1 unsure->fail 2.5m; no-findings; final fail",
		);
		expect(lines[4]).toBe(
			"- heat.1: no check; time (not enough time left for a check and a fix); final PASS",
		);
		expect(lines[5]).toBe(
			"3 run(s), 3 check(s), 1 fix round(s). First checked tree -> final grade: fail->PASS 1, PASS->fail 0, fail->fail 1, PASS->PASS 0, ungraded 0, no check 1.",
		);
		expect(lines[6]).toMatch(/^Checker accuracy over 3 graded attempt/);
		expect(
			reviewLoopReport([
				{ task: "x", attempt: "1", status: "final", passed: true },
			]),
		).toEqual([]);
	});
});
