// The hard set's review-loop record (review=on) and its report: per run the
// rounds, the checker's verdict on each checked tree against that tree's own
// grade, and whether a fix turned a failing tree into a passing one.
import {
	type AttemptSnapshot,
	type AttemptVerdictKind,
	checkerAccuracy,
	formatCheckerAccuracy,
} from "../../src/domain/attempt-loop";
import type { ReviewLoopState } from "../../src/domain/review-loop";

/**
 * The review state a record reports: the latest one that ran a round. A
 * session has one state per turn, and the checker's completion is delivered
 * to the builder as a child event that wakes a short follow-up turn whose
 * own state is "not-eligible (no files changed)"; the last state alone hid
 * the round that was checked (rl-live-2).
 */
export function reviewStateForRecord(states: readonly ReviewLoopState[]) {
	const ran = states.filter((state) => state.rounds.length > 0);
	return ran.at(-1) ?? states.at(-1) ?? null;
}

export type HardSetReviewRound = {
	n: number;
	verdict: AttemptVerdictKind | null;
	timedOut: boolean;
	truncated: boolean;
	findings: number;
	findingTexts: string[];
	/** The tests the checker wrote and ran (absent on records before 2026-10-19). */
	checkerTests?: { name: string; passed: boolean; command: string | null }[];
	/** It said pass without a test of its own (parsed as unsure). */
	untested?: boolean;
	/** fix, or why the loop stopped after this round. */
	decision: string | null;
	checkerTokens: number;
	checkerCostUsd: number | null;
	checkMinutes: number;
	fixTokens: number;
	fixCostUsd: number | null;
	fixMinutes: number;
	fixed: number;
	rejected: number;
	unanswered: number;
	/** The tree the checker reviewed. */
	tree: string;
	snapshot: AttemptSnapshot;
	sameAsFinal: boolean;
	gradeName: string | null;
	/** The grader's result for the checked tree (the final grade when it is the final tree). */
	graderReward: number | null;
	graderPassed: boolean | null;
};

export type HardSetReviewRecord = {
	phase: string;
	outcome: string | null;
	note: string | null;
	rounds: HardSetReviewRound[];
	/** Checker spend on top of the builder's turn (fix tokens are in the turn's own). */
	extraTokens: number;
	extraCostUsd: number | null;
	checkers: number;
	finalTree: string | null;
	branch: string;
	attemptGrading: "none" | "grading" | "final";
	notes: string[];
};

type RunWithReview = {
	readonly task: string;
	readonly attempt: string;
	readonly status: string;
	readonly passed: boolean;
	readonly variant?: string;
	readonly reviewLoop?: HardSetReviewRecord | null;
	/** The copied state rows: absent on records written before they were kept. */
	readonly loopStates?: { readonly review: readonly unknown[] } | null;
};

const reviewOn = (variant: string | undefined) =>
	!!variant && /(^|[\s,;])review=on\b/.test(variant);

const grade = (passed: boolean | null) =>
	passed === null ? "?" : passed ? "PASS" : "fail";

/** The checker's own tests, as ` [3 tests, 1 failed]` (empty on older records). */
function checkerTestsLabel(round: HardSetReviewRound) {
	if (!round.checkerTests) return "";
	const failed = round.checkerTests.filter((test) => !test.passed).length;
	const count = round.checkerTests.length;
	return ` [${count} test${count === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""}${round.untested ? ", untested pass" : ""}]`;
}

/** Report lines for the runs that had a review loop (empty when none). */
export function reviewLoopReport(records: readonly RunWithReview[]) {
	const runs = records.filter((record) => record.reviewLoop);
	// review=on runs without a loop record: say whether the loop never ran or was not kept.
	const missing = records.filter(
		(record) => !record.reviewLoop && reviewOn(record.variant),
	);
	if (!runs.length && !missing.length) return [];
	const lines = [
		"",
		"Review loop (checker verdict on the checked tree -> that tree's grade; final grade):",
	];
	for (const record of missing)
		lines.push(
			`- ${record.task}.${record.attempt}: ${record.loopStates ? "review=on but no review loop ran (no state row)" : "review=on; no review-loop state was kept (record predates it)"}; final ${record.status === "final" ? grade(record.passed) : record.status}`,
		);
	if (!runs.length) return lines;
	const moves = {
		failToPass: 0,
		passToFail: 0,
		failStayed: 0,
		passStayed: 0,
		unknown: 0,
		unchecked: 0,
	};
	let checks = 0;
	let fixes = 0;
	for (const record of runs) {
		const loop = record.reviewLoop as HardSetReviewRecord;
		const rounds = loop.rounds
			.map(
				(round) =>
					`R${round.n} ${round.verdict ?? (round.timedOut ? "no-verdict" : "-")}${round.findings ? `(${round.findings})` : ""}${checkerTestsLabel(round)}->${grade(round.graderPassed)} ${round.checkMinutes.toFixed(1)}m${round.decision === "fix" ? ` fix ${round.fixMinutes.toFixed(1)}m fixed ${round.fixed} rejected ${round.rejected}${round.unanswered ? ` unanswered ${round.unanswered}` : ""}` : ""}`,
			)
			.join(", ");
		lines.push(
			`- ${record.task}.${record.attempt}: ${rounds || "no check"}; ${loop.outcome ?? loop.phase}${loop.note ? ` (${loop.note})` : ""}; final ${record.status === "final" ? grade(record.passed) : record.status}${loop.attemptGrading === "grading" ? "; round grades pending (--collect)" : ""}`,
		);
		checks += loop.rounds.length;
		fixes += loop.rounds.filter((round) => round.decision === "fix").length;
		const first = loop.rounds[0];
		if (!first) moves.unchecked++;
		else if (first.graderPassed === null || record.status !== "final")
			moves.unknown++;
		else if (!first.graderPassed && record.passed) moves.failToPass++;
		else if (first.graderPassed && !record.passed) moves.passToFail++;
		else if (!first.graderPassed) moves.failStayed++;
		else moves.passStayed++;
	}
	lines.push(
		`${runs.length} run(s), ${checks} check(s), ${fixes} fix round(s). First checked tree -> final grade: fail->PASS ${moves.failToPass}, PASS->fail ${moves.passToFail}, fail->fail ${moves.failStayed}, PASS->PASS ${moves.passStayed}, ungraded ${moves.unknown}, no check ${moves.unchecked}.`,
	);
	const rows = runs.flatMap((record) =>
		(record.reviewLoop as HardSetReviewRecord).rounds.flatMap((round) =>
			round.verdict && round.graderPassed !== null
				? [{ verdict: round.verdict, graderPassed: round.graderPassed }]
				: [],
		),
	);
	if (rows.length) lines.push(formatCheckerAccuracy(checkerAccuracy(rows)));
	return lines;
}
