import { describe, expect, it } from "vitest";
import {
	ATTEMPT_LOOP_LIMITS,
	attemptCheckerBrief,
	attemptCutOff,
	attemptDirectory,
	attemptJudgeBrief,
	attemptLimit,
	attemptRef,
	checkerAccuracy,
	decideAfterCheck,
	formatCheckerAccuracy,
	parseCheckerVerdict,
	parseJudgeWinner,
	parseSuiteOutput,
	retryNotice,
	type SelectionCandidate,
	selectCandidate,
	selectionReserveMs,
	usageSince,
} from "./attempt-loop";
import { harnessVariantFromFlags } from "./harness-variant";

describe("attempt loop variant", () => {
	it("is off (one attempt) by default and caps at three", () => {
		expect(harnessVariantFromFlags().attempts).toBe("1");
		expect(harnessVariantFromFlags(["attempts=3"]).attempts).toBe("3");
		expect(() => harnessVariantFromFlags(["attempts=5"])).toThrow(
			"accepts 1, 3",
		);
		expect(attemptLimit("1")).toBe(1);
		expect(attemptLimit("3")).toBe(3);
		expect(attemptLimit("9")).toBe(ATTEMPT_LOOP_LIMITS.maxAttempts);
		expect(attemptLimit(undefined)).toBe(1);
	});

	it("names refs and directories from the turn only", () => {
		expect(attemptRef("t-1/../x", "2")).toBe("refs/ytimesy/attempts/t-1x-2");
		expect(attemptDirectory("turn-1", 2)).toBe(
			"/tmp/ytimesy-attempts/turn-1/2",
		);
	});
});

describe("checker verdicts", () => {
	it("reads the last verdict JSON, even after prose and with braces in strings", () => {
		const verdict = parseCheckerVerdict(
			[
				'I ran the suite. Earlier draft: {"verdict": "pass"}',
				"```json",
				JSON.stringify({
					verdict: "fail",
					failures: ["output.csv: header is {a,b} not {a,b,c}"],
					tests: [
						{ name: "header", passed: false, evidence: "got {a,b}" },
						{ name: "rows", passed: true },
					],
					testsPath: "/tmp/ytimesy-attempts/t/1/tests",
					notes: "ok",
				}),
				"```",
			].join("\n"),
		);
		expect(verdict).toMatchObject({
			verdict: "fail",
			failures: ["output.csv: header is {a,b} not {a,b,c}"],
			testsPath: "/tmp/ytimesy-attempts/t/1/tests",
			parsed: true,
		});
		expect(verdict.tests).toHaveLength(2);
	});

	it("derives failures from failed tests and distrusts a pass with failures", () => {
		const verdict = parseCheckerVerdict(
			JSON.stringify({
				verdict: "pass",
				tests: [{ name: "edge", passed: false, evidence: "crash" }],
			}),
		);
		expect(verdict.verdict).toBe("unsure");
		expect(verdict.failures).toEqual(["edge: crash"]);
	});

	it("treats a report without verdict JSON as unsure, never a pass", () => {
		const verdict = parseCheckerVerdict("Looks good to me, all done!");
		expect(verdict).toMatchObject({ verdict: "unsure", parsed: false });
		expect(parseCheckerVerdict('{"verdict":"maybe"}').parsed).toBe(false);
	});

	it("rejects a relative tests path", () => {
		expect(
			parseCheckerVerdict('{"verdict":"fail","testsPath":"tests"}').testsPath,
		).toBeNull();
	});
});

describe("briefs and notices", () => {
	it("gives the checker the request verbatim and the change, never a report", () => {
		const brief = attemptCheckerBrief({
			taskText: "Write /app/out.txt with the primes below 100.",
			checkout: "/home/ubuntu/app",
			changedFiles: ["out.txt", "gen.py"],
			base: "refs/ytimesy/attempts/t-base",
			candidate: "refs/ytimesy/attempts/t-1",
			directory: "/tmp/ytimesy-attempts/t/1",
		});
		expect(brief).toContain(
			"<task>\nWrite /app/out.txt with the primes below 100.\n</task>",
		);
		expect(brief).toContain(
			"git -C /home/ubuntu/app diff refs/ytimesy/attempts/t-base refs/ytimesy/attempts/t-1",
		);
		expect(brief).toContain("/tmp/ytimesy-attempts/t/1/tests/run.sh");
		expect(brief).toContain("ytimesy-check");
		expect(brief).toContain('"testsPath": "/tmp/ytimesy-attempts/t/1/tests"');
	});

	it("tells the next attempt what failed and to change approach", () => {
		const notice = retryNotice({
			failed: 2,
			next: 3,
			max: 3,
			verdict: parseCheckerVerdict(
				'{"verdict":"fail","failures":["ordering: newer version hidden"]}',
			),
			previousReport: "Fixed the visibility bug.",
			reset: {
				stoppedListeners: ["node on port 3000"],
				notReset: ["files outside the checkout"],
			},
			earlier: [{ n: 1, failures: ["compaction drops tombstones"] }],
		});
		expect(notice).toContain("Attempt 2 of 3 failed an independent check");
		expect(notice).toContain("- ordering: newer version hidden");
		expect(notice).toContain(
			"Attempt 2 had reported: Fixed the visibility bug.",
		);
		expect(notice).toContain(
			"Attempt 1 also failed its check: compaction drops tombstones",
		);
		expect(notice).toContain("node on port 3000");
		expect(notice).toContain("files outside the checkout");
		expect(notice).toContain("This is attempt 3. Take a different approach");
		expect(notice).toContain("not a new user request");
	});

	it("asks the judge for one of two candidates", () => {
		const brief = attemptJudgeBrief({
			taskText: "Task",
			checkout: "/w",
			base: "b",
			a: { ref: "ra", findings: ["x"] },
			b: { ref: "rb", findings: [] },
		});
		expect(brief).toContain("git -C /w diff b ra");
		expect(brief).toContain("an independent check found: x");
		expect(parseJudgeWinner('Reasoning... {"winner":"B","reason":"r"}')).toBe(
			"B",
		);
		expect(parseJudgeWinner("no idea")).toBeNull();
	});
});

describe("decisions", () => {
	const base = {
		attempt: 1,
		max: 3,
		now: 0,
		deadlineAt: 30 * 60_000,
		reserveMs: 60_000,
		meanAttemptMs: 5 * 60_000,
		spentTokens: 500_000,
		meanAttemptTokens: 500_000,
		tokenBudget: 5_000_000,
	};

	it("finishes on pass and retries a fail or unsure while budget remains", () => {
		expect(decideAfterCheck({ ...base, verdict: "pass" })).toEqual({
			kind: "finish",
		});
		expect(decideAfterCheck({ ...base, verdict: "fail" })).toEqual({
			kind: "retry",
		});
		expect(decideAfterCheck({ ...base, verdict: "unsure" })).toEqual({
			kind: "retry",
		});
	});

	it("selects when attempts, time or tokens run out", () => {
		expect(decideAfterCheck({ ...base, verdict: "fail", attempt: 3 })).toEqual({
			kind: "select",
			reason: "attempts",
		});
		expect(
			decideAfterCheck({ ...base, verdict: "fail", deadlineAt: 3 * 60_000 }),
		).toEqual({ kind: "select", reason: "time" });
		expect(
			decideAfterCheck({ ...base, verdict: "fail", spentTokens: 4_800_000 }),
		).toEqual({ kind: "select", reason: "tokens" });
	});

	it("cuts an attempt off once only the selection reserve is left", () => {
		expect(
			attemptCutOff({ now: 0, deadlineAt: 100_000, reserveMs: 45_000 }),
		).toBe(false);
		expect(
			attemptCutOff({ now: 60_000, deadlineAt: 100_000, reserveMs: 45_000 }),
		).toBe(true);
		expect(selectionReserveMs(7 * 60_000)).toBe(60_000);
		expect(selectionReserveMs(60_000)).toBe(45_000);
	});
});

describe("selection", () => {
	const candidates: SelectionCandidate[] = [
		{ n: 1, verdict: "fail", ownPassRate: 0.5, cutOff: false, tree: "t1" },
		{ n: 2, verdict: "fail", ownPassRate: 0.8, cutOff: false, tree: "t2" },
		{ n: 3, verdict: "unsure", ownPassRate: null, cutOff: false, tree: "t3" },
	];
	const run = (
		suite: number,
		candidate: number,
		passed: number,
		failed: number,
	) => ({
		suite,
		candidate,
		passed,
		failed,
		exitCode: failed ? 1 : 0,
		timedOut: false,
	});

	it("keeps the candidate that passes the most of every attempt's tests", () => {
		const result = selectCandidate(candidates, [
			run(1, 1, 2, 2),
			run(2, 1, 1, 3),
			run(1, 2, 4, 0),
			run(2, 2, 3, 1),
			run(1, 3, 3, 1),
			run(2, 3, 2, 2),
		]);
		expect(result.best).toBe(2);
		expect(result.runnerUp).toBe(3);
		expect(result.tie).toBe(false);
		expect(result.reason).toContain("attempt 2 (88% of 2 suite(s))");
	});

	it("ignores a suite that produced nothing on any candidate", () => {
		const broken = (candidate: number) => ({
			suite: 3,
			candidate,
			passed: 0,
			failed: 0,
			exitCode: 127,
			timedOut: false,
		});
		const result = selectCandidate(candidates, [
			run(1, 1, 1, 0),
			run(1, 2, 0, 1),
			run(1, 3, 0, 1),
			broken(1),
			broken(2),
			broken(3),
		]);
		expect(result.best).toBe(1);
		expect(result.scores.find((score) => score.n === 1)?.suitesRun).toBe(1);
	});

	it("falls back to the checkers' verdicts without runs, preferring the later attempt", () => {
		expect(selectCandidate(candidates, []).best).toBe(3);
		const twoFails = selectCandidate(
			[
				{ n: 1, verdict: "fail", ownPassRate: 0.5, cutOff: false, tree: "a" },
				{ n: 2, verdict: "fail", ownPassRate: 0.5, cutOff: false, tree: "b" },
			],
			[],
		);
		expect(twoFails.best).toBe(2);
		expect(twoFails.tie).toBe(true);
	});

	it("counts identical trees once and flags a tie for the judge", () => {
		const result = selectCandidate(
			[
				{ n: 1, verdict: "fail", ownPassRate: 0, cutOff: false, tree: "same" },
				{ n: 2, verdict: "fail", ownPassRate: 0, cutOff: false, tree: "same" },
				{ n: 3, verdict: "fail", ownPassRate: 0, cutOff: false, tree: "other" },
			],
			[run(1, 2, 1, 1), run(1, 3, 1, 1)],
		);
		expect(result.scores.map((score) => score.n)).toEqual([2, 3]);
		expect(result.tie).toBe(true);
		expect(result.best).toBe(3);
		expect(result.runnerUp).toBe(2);
	});

	it("reads PASS and FAIL lines", () => {
		expect(
			parseSuiteOutput("PASS a\nnoise\n  FAIL b: wrong\nPASSWORD x\nPASS c"),
		).toEqual({ passed: 2, failed: 1 });
	});
});

describe("accounting and accuracy", () => {
	it("subtracts usage per field", () => {
		expect(
			usageSince(
				{
					inputTokens: 300,
					outputTokens: 30,
					uncachedInputTokens: 100,
					cacheReadTokens: 200,
					cacheWriteTokens: 0,
				},
				{
					inputTokens: 100,
					outputTokens: 10,
					uncachedInputTokens: 50,
					cacheReadTokens: 50,
					cacheWriteTokens: 0,
				},
			),
		).toEqual({
			inputTokens: 200,
			outputTokens: 20,
			uncachedInputTokens: 50,
			cacheReadTokens: 150,
			cacheWriteTokens: 0,
		});
		expect(usageSince(null, null)).toBeNull();
	});

	it("scores the checker against the grader", () => {
		const accuracy = checkerAccuracy([
			{ verdict: "pass", graderPassed: true },
			{ verdict: "pass", graderPassed: true },
			{ verdict: "pass", graderPassed: false },
			{ verdict: "fail", graderPassed: false },
			{ verdict: "fail", graderPassed: true },
			{ verdict: "unsure", graderPassed: false },
		]);
		expect(accuracy.n).toBe(6);
		expect(accuracy.agreement).toBeCloseTo(3 / 5);
		expect(accuracy.falsePassRate).toBeCloseTo(1 / 3);
		expect(accuracy.falseFailRate).toBeCloseTo(1 / 2);
		expect(accuracy.unsureRate).toBeCloseTo(1 / 6);
		const text = formatCheckerAccuracy(accuracy);
		expect(text).toContain("agreement 60%");
		expect(text).toContain("false-pass 33%");
		expect(text).toContain("checker pass:   grader pass 2, grader fail 1");
		expect(checkerAccuracy([]).agreement).toBeNull();
	});
});
