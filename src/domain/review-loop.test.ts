import { describe, expect, it } from "vitest";
import { parseReviewVerdict } from "./checker-brief";
import {
	decideAfterVerdict,
	decideCheck,
	failingTests,
	findingResponses,
	hasConcreteFindings,
	isRunnableFile,
	REVIEW_LOOP_LIMITS,
	reviewEligibility,
	reviewFindings,
	reviewNotice,
} from "./review-loop";

const review = (value: Record<string, unknown>) =>
	parseReviewVerdict(JSON.stringify(value));

describe("review findings", () => {
	it("lists failures, then unmet requirements not already listed, then assumptions", () => {
		const findings = reviewFindings(
			review({
				verdict: "fail",
				failures: ["total: off by one (9 vs 10)"],
				requirements: [
					{ requirement: "total", met: false, evidence: "9 vs 10" },
					{ requirement: "header row", met: false, evidence: "missing" },
					{ requirement: "file exists", met: true, evidence: "ls" },
				],
				assumptions: [
					{ assumption: "inclusive", alternative: "exclusive", outcome: "10" },
				],
			}),
		);
		expect(findings.map((finding) => [finding.id, finding.kind])).toEqual([
			["F1", "failure"],
			["F2", "requirement"],
			["F3", "assumption"],
		]);
		expect(findings[1].text).toBe("header row: missing");
		expect(findings[2].text).toBe(
			"Assumption: inclusive; alternative: exclusive; checker's outcome: 10",
		);
		expect(hasConcreteFindings(findings)).toBe(true);
	});

	it("has nothing concrete for a missing verdict or assumptions alone", () => {
		expect(reviewFindings(parseReviewVerdict("no json"))).toEqual([]);
		expect(
			reviewFindings(
				review({
					verdict: "unsure",
					failures: [],
					assumptions: [{ assumption: "a", alternative: "b", outcome: "c" }],
				}),
			),
		).toEqual([]);
	});

	it("caps the findings and builds a lean notice", () => {
		const many = review({
			verdict: "fail",
			failures: Array.from({ length: 12 }, (_, index) => `f${index}`),
		});
		const findings = reviewFindings(many);
		expect(findings).toHaveLength(REVIEW_LOOP_LIMITS.maxFindings);
		const notice = reviewNotice({ round: 1, maxRounds: 2, findings });
		expect(notice.split("\n")).toHaveLength(findings.length + 2);
		expect(notice).toContain("(review 1 of 2)");
		expect(notice).toContain("it can be wrong");
	});

	it("hands over the checker's failing tests with command and output", () => {
		const verdict = review({
			verdict: "fail",
			failures: ["x: wrong"],
			tests: [
				{ name: "ok", command: "true", passed: true },
				...Array.from({ length: 7 }, (_, index) => ({
					name: `t${index}`,
					command: `bash /s/tests/t${index}.sh`,
					passed: false,
					output: "line1\n  line2",
				})),
				{ name: "no command", passed: false, evidence: "seen" },
			],
		});
		const tests = failingTests(verdict);
		expect(tests.map((test) => test.name)).toEqual([
			"t0",
			"t1",
			"t2",
			"t3",
			"t4",
		]);
		const notice = reviewNotice({
			round: 1,
			maxRounds: 2,
			findings: reviewFindings(verdict),
			failingTests: tests,
		});
		expect(notice).toContain("- t0: `bash /s/tests/t0.sh` -> line1 | line2");
		expect(notice).not.toContain("- ok");
		expect(
			reviewNotice({
				round: 1,
				maxRounds: 2,
				findings: [],
				failingTests: failingTests(
					review({
						verdict: "fail",
						tests: [{ name: "no command", passed: false, evidence: "seen" }],
					}),
				),
			}),
		).toContain("- no command -> seen");
		expect(failingTests(null)).toEqual([]);
	});
});

describe("finding responses", () => {
	const findings = reviewFindings(
		review({ verdict: "fail", failures: ["a", "b", "c", "d"] }),
	);

	it("reads fixed and rejected lines in common markdown shapes", () => {
		const answer = [
			"Summary of the fix.",
			"- **F1**: fixed",
			"F2: rejected - the spec allows it (README line 4)",
			"* `F3` - Rejected: covered by test_x",
			"F9: fixed",
			"F1: rejected - duplicate line is ignored",
		].join("\n");
		expect(findingResponses(answer, findings)).toEqual({
			fixed: ["F1"],
			rejected: [
				{ id: "F2", reason: "the spec allows it (README line 4)" },
				{ id: "F3", reason: "covered by test_x" },
			],
			unanswered: ["F4"],
		});
	});
});

describe("review gating and time", () => {
	it("reviews only turns that changed files and are long or runnable", () => {
		expect(reviewEligibility({ changedFiles: [], turnMs: 1e9 })).toEqual({
			review: false,
			reason: "no files changed",
		});
		expect(
			reviewEligibility({ changedFiles: ["notes.md"], turnMs: 60_000 }).review,
		).toBe(false);
		expect(
			reviewEligibility({ changedFiles: ["notes.md"], turnMs: 4 * 60_000 })
				.review,
		).toBe(true);
		expect(
			reviewEligibility({ changedFiles: ["src/x.ts"], turnMs: 10_000 }).review,
		).toBe(true);
		for (const file of ["run.sh", "Makefile", "a/Dockerfile", "pyproject.toml"])
			expect(isRunnableFile(file)).toBe(true);
		for (const file of ["README.md", "out.csv", "image.png"])
			expect(isRunnableFile(file)).toBe(false);
	});

	it("checks only when a check and a fix fit, and gives the check the rest", () => {
		const base = { checksDone: 0, now: 0, expectedCheckMs: 150_000 };
		expect(decideCheck({ ...base, deadlineAt: 200_000 })).toEqual({
			kind: "finish",
			reason: "time",
		});
		expect(decideCheck({ ...base, deadlineAt: 300_000 })).toEqual({
			kind: "check",
			checkMs: 240_000,
		});
		expect(decideCheck({ ...base, deadlineAt: 1e9 })).toEqual({
			kind: "check",
			checkMs: REVIEW_LOOP_LIMITS.checker.minutes * 60_000,
		});
		// checkerMode=pair: a longer check, still bounded by the deadline less a fix.
		expect(REVIEW_LOOP_LIMITS.pairCheckerMinutes).toBeGreaterThan(
			REVIEW_LOOP_LIMITS.checker.minutes,
		);
		expect(decideCheck({ ...base, deadlineAt: 1e9, pair: true })).toEqual({
			kind: "check",
			checkMs: REVIEW_LOOP_LIMITS.pairCheckerMinutes * 60_000,
		});
		expect(decideCheck({ ...base, deadlineAt: 300_000, pair: true })).toEqual({
			kind: "check",
			checkMs: 240_000,
		});
		expect(decideCheck({ ...base, checksDone: 2, deadlineAt: 1e9 })).toEqual({
			kind: "finish",
			reason: "rounds",
		});
	});

	it("fixes only concrete findings with time left", () => {
		const fail = review({ verdict: "fail", failures: ["x"] });
		const findings = reviewFindings(fail);
		expect(
			decideAfterVerdict({ verdict: fail, findings, now: 0, deadlineAt: 1e9 }),
		).toEqual({ kind: "fix" });
		expect(
			decideAfterVerdict({ verdict: fail, findings, now: 0, deadlineAt: 1000 }),
		).toEqual({ kind: "finish", reason: "time" });
		const pass = review({
			verdict: "pass",
			failures: [],
			tests: [{ name: "edge", command: "c", passed: true }],
		});
		expect(
			decideAfterVerdict({
				verdict: pass,
				findings: [],
				now: 0,
				deadlineAt: 1e9,
			}),
		).toEqual({ kind: "finish", reason: "pass" });
		const unsure = review({ verdict: "unsure", failures: [] });
		expect(
			decideAfterVerdict({
				verdict: unsure,
				findings: [],
				now: 0,
				deadlineAt: 1e9,
			}),
		).toEqual({ kind: "finish", reason: "unsure" });
		// Unsure with findings still finishes: only a fail sends the builder back.
		expect(
			decideAfterVerdict({
				verdict: review({ verdict: "unsure", failures: ["x: maybe wrong"] }),
				findings: [{ kind: "failure", text: "x: maybe wrong" } as never],
				now: 0,
				deadlineAt: 1e9,
			}),
		).toEqual({ kind: "finish", reason: "unsure" });
	});
});
