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
	checkerTests?: {
		name: string;
		passed: boolean;
		command: string | null;
		/** checkerMode=pair: which of the pair ran its command (absent: neither, or a single checker). */
		ranBy?: "worker" | "judge";
	}[];
	/** It said pass without a test of its own (flagged untested). */
	untested?: boolean;
	/** rigor=on: the builder's requirements list the checker got (absent before 2026-10-20). */
	builderRequirements?: string[];
	/** fix, or why the loop stopped after this round. */
	decision: string | null;
	checkerTokens: number;
	checkerCostUsd: number | null;
	/** checkerMode=pair: the checker's spend split as judge and its workers (absent for a single checker). */
	pair?: PairSpend & { workers: number };
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

/** checkerMode=pair: the judge's and its workers' share of the checker's spend. */
export type PairSpend = {
	judgeTokens: number;
	judgeCostUsd: number | null;
	workerTokens: number;
	workerCostUsd: number | null;
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
	/** checkerMode=pair: the checker spend above, split as judge and worker. */
	pair?: PairSpend;
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
	const byWorker = round.checkerTests.filter(
		(test) => test.ranBy === "worker",
	).length;
	return ` [${count} test${count === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""}${round.pair ? `, ${byWorker} run by the worker` : ""}${round.untested ? ", untested pass" : ""}${round.builderRequirements ? `, builder listed ${round.builderRequirements.length} requirement${round.builderRequirements.length === 1 ? "" : "s"}` : ""}]`;
}

const dollars = (value: number | null) =>
	value === null ? "$?" : `$${value.toFixed(value < 1 ? 3 : 2)}`;

/** checkerMode=pair: ` judge $0.050 / worker $0.020`. */
function pairLabel(spend: PairSpend | undefined) {
	return spend
		? ` judge ${dollars(spend.judgeCostUsd)} / worker ${dollars(spend.workerCostUsd)}`
		: "";
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
					`R${round.n} ${round.verdict ?? (round.timedOut ? "no-verdict" : "-")}${round.findings ? `(${round.findings})` : ""}${checkerTestsLabel(round)}->${grade(round.graderPassed)} ${round.checkMinutes.toFixed(1)}m${pairLabel(round.pair)}${round.decision === "fix" ? ` fix ${round.fixMinutes.toFixed(1)}m fixed ${round.fixed} rejected ${round.rejected}${round.unanswered ? ` unanswered ${round.unanswered}` : ""}` : ""}`,
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
	const paired = runs.flatMap((record) => record.reviewLoop?.pair ?? []);
	if (paired.length) {
		const sum = (pick: (spend: PairSpend) => number | null) =>
			paired.reduce<number | null>(
				(total, spend) =>
					total === null || pick(spend) === null
						? null
						: total + (pick(spend) as number),
				0,
			);
		const judge = sum((spend) => spend.judgeCostUsd);
		const worker = sum((spend) => spend.workerCostUsd);
		const share = (part: number | null) =>
			part !== null && judge !== null && worker !== null && judge + worker > 0
				? ` (${Math.round((part / (judge + worker)) * 100)}%)`
				: "";
		lines.push(
			`Checker pair spend over ${paired.length} run(s): judge ${dollars(judge)}${share(judge)}, ${Math.round((sum((spend) => spend.judgeTokens) ?? 0) / 1000)}k tokens; worker ${dollars(worker)}${share(worker)}, ${Math.round((sum((spend) => spend.workerTokens) ?? 0) / 1000)}k tokens.`,
		);
	}
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
