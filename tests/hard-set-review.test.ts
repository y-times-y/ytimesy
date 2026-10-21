import { describe, expect, it } from "vitest";
import {
	type HardSetReviewRecord,
	type HardSetReviewRound,
	reviewLoopReport,
	reviewStateForRecord,
} from "../scripts/hard-set/review-report";
import type { ReviewLoopState } from "../src/domain/review-loop";

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

describe("hard set review report: the checker's own tests", () => {
	it("counts the tests the checker wrote and flags an untested pass", () => {
		const lines = reviewLoopReport([
			{
				task: "mvcc",
				attempt: "1",
				status: "final",
				passed: false,
				reviewLoop: loop(
					[
						round({
							checkerTests: [
								{ name: "a", passed: false, command: "c" },
								{ name: "b", passed: true, command: null },
							],
						}),
						round({
							n: 2,
							verdict: "unsure",
							findings: 0,
							decision: "no-findings",
							checkerTests: [],
							untested: true,
						}),
					],
					{ outcome: "no-findings" },
				),
			},
		]);
		expect(lines[2]).toBe(
			"- mvcc.1: R1 fail(2) [2 tests, 1 failed]->fail 2.5m fix 1.2m fixed 1 rejected 1, R2 unsure [0 tests, untested pass]->fail 2.5m; no-findings; final fail",
		);
	});
});

describe("hard set review report: checkerMode=pair", () => {
	it("splits the checker's spend as judge and worker per round and over the runs", () => {
		const pair = {
			judgeTokens: 20_000,
			judgeCostUsd: 0.04,
			workerTokens: 300_000,
			workerCostUsd: 0.06,
		};
		const lines = reviewLoopReport([
			{
				task: "mvcc",
				attempt: "1",
				status: "final",
				passed: true,
				reviewLoop: loop(
					[
						round({
							checkerTests: [
								{ name: "a", passed: false, command: "c", ranBy: "worker" },
								{ name: "b", passed: true, command: "d", ranBy: "judge" },
								{ name: "c", passed: true, command: "e" },
							],
							pair: { ...pair, workers: 1 },
						}),
						round({
							n: 2,
							verdict: "pass",
							findings: 0,
							decision: "pass",
							graderPassed: true,
							pair: { ...pair, workers: 2 },
						}),
					],
					{
						pair: {
							judgeTokens: 40_000,
							judgeCostUsd: 0.08,
							workerTokens: 600_000,
							workerCostUsd: 0.12,
						},
					},
				),
			},
		]);
		expect(lines[2]).toBe(
			"- mvcc.1: R1 fail(2) [3 tests, 1 failed, 1 run by the worker]->fail 2.5m judge $0.040 / worker $0.060 fix 1.2m fixed 1 rejected 1, R2 pass->PASS 2.5m judge $0.040 / worker $0.060; pass; final PASS",
		);
		expect(lines).toContain(
			"Checker pair spend over 1 run(s): judge $0.080 (40%), 40k tokens; worker $0.120 (60%), 600k tokens.",
		);
	});
});

describe("hard set review state", () => {
	// rl-live-2: the checker's completion woke a second builder turn whose
	// own state was "not-eligible (no files changed)".
	const checked = {
		turnId: "turn-1",
		outcome: "no-findings",
		rounds: [{ n: 1 }],
	} as unknown as ReviewLoopState;
	const wake = {
		turnId: "turn-2",
		outcome: "not-eligible",
		rounds: [],
	} as unknown as ReviewLoopState;

	it("reports the latest state that ran a round, not a later empty wake turn", () => {
		expect(reviewStateForRecord([checked, wake])).toBe(checked);
	});

	it("falls back to the last state when no turn ran a round", () => {
		expect(reviewStateForRecord([wake])).toBe(wake);
		expect(reviewStateForRecord([])).toBeNull();
	});
});
