import type { ApiTokenUsage } from "./api-token-usage";

/**
 * The attempt loop (decision 2026-10-17, Phase 2; harness variant
 * attempts=3): the builder attempts the task, an independent checker
 * subagent judges the delivered result against the user's request, a failed
 * or unsure attempt is kept as a candidate and the working tree is reset for
 * a different approach, and at the end the best candidate is kept. These are
 * the pure rules; the runtime is src/server/services/attempt-loop.ts.
 */

export const ATTEMPT_VERDICTS = ["pass", "fail", "unsure"] as const;
export type AttemptVerdictKind = (typeof ATTEMPT_VERDICTS)[number];

export type CheckerTest = {
	readonly name: string;
	readonly passed: boolean;
	readonly evidence?: string;
};

/** The checker's structured answer, normalized. */
export type CheckerVerdict = {
	readonly verdict: AttemptVerdictKind;
	readonly failures: readonly string[];
	readonly tests: readonly CheckerTest[];
	/** Where its acceptance tests (and run.sh) are, as it reported them. */
	readonly testsPath: string | null;
	readonly notes: string;
	/** False when the report held no verdict JSON (counted as unsure). */
	readonly parsed: boolean;
};

/** Starting values; the measurement plan tunes them. */
export const ATTEMPT_LOOP_LIMITS = {
	maxAttempts: 3,
	/** Wall time of the whole loop in the product (a runner's deadline can only shorten it). */
	loopMinutes: 90,
	/** Builder + checkers + judge tokens: the per-task tree allowance. */
	tokens: 5_000_000,
	/** Kept free before the deadline for selection and the final restore. */
	minSelectionReserveMs: 45_000,
	/** A new attempt needs at least this much time beyond the reserve. */
	minAttemptMs: 60_000,
	checker: { steps: 60, minutes: 12, tokens: 800_000 },
	judge: { steps: 20, minutes: 4, tokens: 200_000 },
	/** One acceptance suite against one candidate. */
	suiteSeconds: 120,
} as const;

export const ATTEMPT_TESTS_ROOT = "/tmp/ytimesy-attempts";

/** The checker of attempt `n` writes its tests (and its copy of the checkout) here. */
export function attemptDirectory(turnId: string, n: number) {
	const safe = turnId.replaceAll(/[^a-zA-Z0-9-]/g, "").slice(0, 64);
	return `${ATTEMPT_TESTS_ROOT}/${safe || "turn"}/${n}`;
}

export function attemptRef(turnId: string, label: string) {
	const safe = turnId.replaceAll(/[^a-zA-Z0-9-]/g, "").slice(0, 64);
	return `refs/ytimesy/attempts/${safe || "turn"}-${label}`;
}

/** The loop runs up to `max` attempts; 1 is the product's unchanged behaviour. */
export function attemptLimit(value: string | undefined) {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= 1
		? Math.min(parsed, ATTEMPT_LOOP_LIMITS.maxAttempts)
		: 1;
}

/** Time kept for selection: at least the minimum, else a seventh of the loop. */
export function selectionReserveMs(loopMs: number) {
	return Math.max(ATTEMPT_LOOP_LIMITS.minSelectionReserveMs, loopMs / 7);
}

// ---------------------------------------------------------------------------
// The checker's verdict.

/** Every balanced top-level {...} in a text, last first (strings respected). */
function jsonObjects(text: string): string[] {
	const found: string[] = [];
	for (let end = text.lastIndexOf("}"); end >= 0; ) {
		let depth = 0;
		let start = -1;
		let inString = false;
		// Scan backwards for the matching opening brace.
		for (let index = end; index >= 0; index--) {
			const char = text[index];
			if (inString) {
				if (char === '"') {
					let slashes = 0;
					for (let back = index - 1; back >= 0 && text[back] === "\\"; back--)
						slashes++;
					if (slashes % 2 === 0) inString = false;
				}
				continue;
			}
			if (char === '"') inString = true;
			else if (char === "}") depth++;
			else if (char === "{") {
				depth--;
				if (depth === 0) {
					start = index;
					break;
				}
			}
		}
		if (start < 0) break;
		found.push(text.slice(start, end + 1));
		end = text.lastIndexOf("}", start - 1);
	}
	return found;
}

const text = (value: unknown, max: number) =>
	typeof value === "string" ? value.trim().slice(0, max) : "";

/**
 * The verdict in a checker's report: the last JSON object with a valid
 * `verdict`. A "pass" whose own tests failed is not trusted (unsure). No JSON
 * is an unsure verdict, never a pass.
 */
export function parseCheckerVerdict(report: string): CheckerVerdict {
	for (const candidate of jsonObjects(report)) {
		let value: unknown;
		try {
			value = JSON.parse(candidate);
		} catch {
			continue;
		}
		if (!value || typeof value !== "object") continue;
		const record = value as Record<string, unknown>;
		const verdict = record.verdict;
		if (!(ATTEMPT_VERDICTS as readonly unknown[]).includes(verdict)) continue;
		const tests: CheckerTest[] = Array.isArray(record.tests)
			? record.tests.slice(0, 100).flatMap((entry) => {
					if (!entry || typeof entry !== "object") return [];
					const test = entry as Record<string, unknown>;
					const name = text(test.name, 200);
					if (!name || typeof test.passed !== "boolean") return [];
					const evidence = text(test.evidence, 600);
					return [
						{ name, passed: test.passed, ...(evidence ? { evidence } : {}) },
					];
				})
			: [];
		const listed = Array.isArray(record.failures)
			? record.failures
					.map((failure) =>
						typeof failure === "string"
							? text(failure, 600)
							: failure && typeof failure === "object"
								? text(JSON.stringify(failure), 600)
								: "",
					)
					.filter(Boolean)
			: [];
		const failures = (
			listed.length
				? listed
				: tests
						.filter((test) => !test.passed)
						.map((test) =>
							test.evidence ? `${test.name}: ${test.evidence}` : test.name,
						)
		).slice(0, 20);
		const testsPath = text(record.testsPath, 500);
		const anyFailed = tests.some((test) => !test.passed);
		return {
			verdict:
				verdict === "pass" && (anyFailed || listed.length)
					? "unsure"
					: (verdict as AttemptVerdictKind),
			failures,
			tests,
			testsPath: testsPath.startsWith("/") ? testsPath : null,
			notes: text(record.notes, 2000),
			parsed: true,
		};
	}
	return {
		verdict: "unsure",
		failures: ["The checker's report held no verdict JSON."],
		tests: [],
		testsPath: null,
		notes: report.trim().slice(-800),
		parsed: false,
	};
}

// ---------------------------------------------------------------------------
// Briefs and notices (kept lean: the builder never sees the loop's rules).

/**
 * The checker's whole brief for one attempt, built by the runtime: the
 * user's request verbatim and the delivered result (changed files and the
 * diff command), never the builder's reasoning or report.
 */
export function attemptCheckerBrief(input: {
	readonly taskText: string;
	readonly checkout: string;
	readonly changedFiles: readonly string[];
	/** The commit the attempt started from and the commit of its result. */
	readonly base: string;
	readonly candidate: string;
	readonly directory: string;
}) {
	const tests = `${input.directory}/tests`;
	const work = `${input.directory}/work`;
	return [
		"You are an independent checker. Decide whether the delivered work below meets the task. You did not build it and nobody will tell you what to look for; a strict grader with hidden tests will judge it next.",
		"",
		"<task>",
		input.taskText,
		"</task>",
		"",
		"<deliverable>",
		`The working tree at ${input.checkout}. ${input.changedFiles.length ? `Changed files: ${input.changedFiles.slice(0, 200).join(", ")}.` : "No files changed."} \`git -C ${input.checkout} diff ${input.base} ${input.candidate}\` shows the whole change.`,
		"</deliverable>",
		"",
		"Steps:",
		`1. The checkout is read-only for you. Copy it (\`cp -a ${input.checkout} ${work}\`) and run things in the copy; read the checkout's own path only where the task names it.`,
		`2. From the task text alone, write acceptance tests in ${tests}: every explicit requirement, exact names, paths and output formats, edge cases and the inputs a strict grader would try, and that the delivered files alone are enough (no scratch data, caches or untracked helpers).`,
		`3. Write ${tests}/run.sh: \`bash ${tests}/run.sh <dir>\` runs every test against the checkout at <dir>, prints one line per test (\`PASS <name>\` or \`FAIL <name>: <reason>\`), writes temporary files only under \`mktemp -d\`, exits 0 only when all pass and finishes within 2 minutes. Include the project's own checks where they apply, and \`ytimesy-check\` on the deliverable when the task delivers something a third party runs.`,
		`4. Run \`bash ${tests}/run.sh ${work}\`, and read the code where a test cannot reach.`,
		"5. Answer with only this JSON:",
		`{ "verdict": "pass" | "fail" | "unsure", "failures": ["<requirement>: <what is wrong, with evidence>"], "tests": [{ "name": "...", "passed": true, "evidence": "..." }], "testsPath": "${tests}", "notes": "..." }`,
		"pass only when every test passes and nothing the task requires is missing; fail when something required is wrong or missing; unsure when you could not test what matters.",
	].join("\n");
}

/** The tiebreak judge's brief: the request and two candidates' changes, nothing else. */
export function attemptJudgeBrief(input: {
	readonly taskText: string;
	readonly checkout: string;
	readonly base: string;
	readonly a: { readonly ref: string; readonly findings: readonly string[] };
	readonly b: { readonly ref: string; readonly findings: readonly string[] };
}) {
	const describe = (
		label: string,
		candidate: { ref: string; findings: readonly string[] },
	) =>
		`Candidate ${label}: \`git -C ${input.checkout} diff ${input.base} ${candidate.ref}\`${candidate.findings.length ? `; an independent check found: ${candidate.findings.slice(0, 5).join("; ")}` : ""}.`;
	return [
		"Two candidate solutions to the task below scored the same on acceptance tests. Pick the one a strict grader with hidden tests is more likely to accept. Read both diffs (do not change the checkout).",
		"",
		"<task>",
		input.taskText,
		"</task>",
		"",
		describe("A", input.a),
		describe("B", input.b),
		"",
		'Answer with only this JSON: { "winner": "A" | "B", "reason": "..." }',
	].join("\n");
}

export function parseJudgeWinner(report: string): "A" | "B" | null {
	for (const candidate of jsonObjects(report)) {
		try {
			const value = JSON.parse(candidate) as { winner?: unknown };
			if (value?.winner === "A" || value?.winner === "B") return value.winner;
		} catch {}
	}
	return null;
}

/** What the runtime could not undo between attempts, for the next attempt and the record. */
export type ResetReport = {
	readonly stoppedListeners: readonly string[];
	readonly notReset: readonly string[];
};

/**
 * The runtime notice that starts the next attempt. It replaces the failed
 * attempt's history (the model sees the request, then this), so it carries
 * what the next attempt needs: the findings and what was tried.
 */
export function retryNotice(input: {
	readonly failed: number;
	readonly next: number;
	readonly max: number;
	readonly verdict: CheckerVerdict;
	readonly previousReport: string;
	readonly reset: ResetReport;
	/** Attempts before the one that just failed, with their findings. */
	readonly earlier?: readonly {
		readonly n: number;
		readonly failures: readonly string[];
	}[];
}) {
	const findings = input.verdict.failures.length
		? input.verdict.failures.slice(0, 8).map((failure) => `- ${failure}`)
		: [
				`- ${input.verdict.notes.slice(0, 600) || "No specific failure was reported; the checker could not confirm the result."}`,
			];
	const report = input.previousReport.trim().slice(0, 900);
	return [
		`Runtime notice, not a new user request. Attempt ${input.failed} of ${input.max} ${input.verdict.verdict === "fail" ? "failed" : "was not confirmed by"} an independent check against the request above. Its work is kept aside as a candidate, and the working tree is back where it was before attempt ${input.failed}.`,
		"The check found:",
		...findings,
		...(report ? [`Attempt ${input.failed} had reported: ${report}`] : []),
		...(input.earlier ?? []).map(
			(attempt) =>
				`Attempt ${attempt.n} also failed its check: ${attempt.failures.slice(0, 3).join("; ").slice(0, 500) || "no specific finding"}.`,
		),
		...(input.reset.stoppedListeners.length
			? [
					`Stopped servers it left running: ${input.reset.stoppedListeners.join(", ")}.`,
				]
			: []),
		...(input.reset.notReset.length
			? [
					`Not reset (still as attempt ${input.failed} left it): ${input.reset.notReset.join("; ")}.`,
				]
			: []),
		`This is attempt ${input.next}. Take a different approach: question the assumption the findings point at, re-read the request for exact requirements, and before finishing test the cases a strict grader would try.`,
	].join("\n");
}

// ---------------------------------------------------------------------------
// Decisions.

export type AttemptDecision =
	| { readonly kind: "finish" }
	| { readonly kind: "retry" }
	| {
			readonly kind: "select";
			readonly reason: "attempts" | "time" | "tokens";
	  };

/** After a check: pass finishes, otherwise retry while attempts, time and tokens allow. */
export function decideAfterCheck(input: {
	readonly verdict: AttemptVerdictKind;
	readonly attempt: number;
	readonly max: number;
	readonly now: number;
	readonly deadlineAt: number;
	readonly reserveMs: number;
	/** Mean wall time of an attempt with its check so far. */
	readonly meanAttemptMs: number;
	readonly spentTokens: number;
	readonly meanAttemptTokens: number;
	readonly tokenBudget: number;
}): AttemptDecision {
	if (input.verdict === "pass") return { kind: "finish" };
	if (input.attempt >= input.max) return { kind: "select", reason: "attempts" };
	const available = input.deadlineAt - input.now - input.reserveMs;
	if (
		available <
		Math.max(ATTEMPT_LOOP_LIMITS.minAttemptMs, input.meanAttemptMs * 0.6)
	)
		return { kind: "select", reason: "time" };
	if (input.spentTokens + input.meanAttemptTokens > input.tokenBudget)
		return { kind: "select", reason: "tokens" };
	return { kind: "retry" };
}

/** An attempt still running when only the selection reserve is left is cut off. */
export function attemptCutOff(input: {
	readonly now: number;
	readonly deadlineAt: number;
	readonly reserveMs: number;
}) {
	return input.now >= input.deadlineAt - input.reserveMs;
}

// ---------------------------------------------------------------------------
// Selection: every attempt's tests against every candidate.

/** One acceptance suite run against one candidate. */
export type SuiteRun = {
	readonly suite: number;
	readonly candidate: number;
	readonly passed: number;
	readonly failed: number;
	readonly exitCode: number | null;
	readonly timedOut: boolean;
};

/** PASS/FAIL lines from a run.sh, per the checker's contract. */
export function parseSuiteOutput(output: string) {
	let passed = 0;
	let failed = 0;
	for (const line of output.split("\n")) {
		if (/^\s*PASS\b/.test(line)) passed++;
		else if (/^\s*FAIL\b/.test(line)) failed++;
	}
	return { passed, failed };
}

export type SelectionCandidate = {
	readonly n: number;
	readonly verdict: AttemptVerdictKind | null;
	/** Fraction of its own checker's tests that passed (when it reported tests). */
	readonly ownPassRate: number | null;
	readonly cutOff: boolean;
	/** The candidate's tree: identical trees are one candidate. */
	readonly tree: string;
};

export type CandidateScore = {
	readonly n: number;
	/** Mean pass fraction over the suites that discriminate (null without runs). */
	readonly crossScore: number | null;
	readonly verdictScore: number;
	readonly suitesRun: number;
};

const VERDICT_RANK: Record<AttemptVerdictKind, number> = {
	pass: 3,
	unsure: 2,
	fail: 1,
};

/** The checker's own judgment as a number, the fallback when no suite ran. */
export function verdictScore(candidate: SelectionCandidate) {
	if (candidate.verdict === "pass") return 1;
	if (candidate.verdict === "unsure") return 0.5;
	if (candidate.verdict === "fail") return 0.4 * (candidate.ownPassRate ?? 0);
	return candidate.cutOff ? 0.05 : 0.1;
}

function runFraction(run: SuiteRun) {
	const total = run.passed + run.failed;
	if (total > 0) return run.passed / total;
	return run.exitCode === 0 && !run.timedOut ? 1 : 0;
}

/**
 * Scores each candidate: the mean pass fraction over every usable suite. A
 * suite is unusable when it produced nothing on any candidate (no PASS/FAIL
 * line and a non-zero exit everywhere: a broken suite, not a finding).
 */
export function scoreCandidates(
	candidates: readonly SelectionCandidate[],
	runs: readonly SuiteRun[],
): CandidateScore[] {
	const suites = [...new Set(runs.map((run) => run.suite))];
	const usable = suites.filter((suite) =>
		runs.some(
			(run) =>
				run.suite === suite &&
				(run.passed + run.failed > 0 || (run.exitCode === 0 && !run.timedOut)),
		),
	);
	return candidates.map((candidate) => {
		const own = runs.filter(
			(run) => run.candidate === candidate.n && usable.includes(run.suite),
		);
		return {
			n: candidate.n,
			crossScore: own.length
				? own.reduce((sum, run) => sum + runFraction(run), 0) / own.length
				: null,
			verdictScore: verdictScore(candidate),
			suitesRun: own.length,
		};
	});
}

export type SelectionResult = {
	readonly best: number;
	readonly runnerUp: number | null;
	/** The top two cannot be told apart: a judge may break the tie. */
	readonly tie: boolean;
	readonly scores: readonly CandidateScore[];
	readonly reason: string;
};

/**
 * Keep the best: cross-check score first, then the checker's verdict, then
 * the later attempt (it ran with the earlier findings). Candidates with the
 * same tree count once.
 */
export function selectCandidate(
	candidates: readonly SelectionCandidate[],
	runs: readonly SuiteRun[],
): SelectionResult {
	if (!candidates.length) throw new Error("No candidate to select.");
	// The later of two identical trees stands for both.
	const distinct = candidates.filter(
		(candidate, index) =>
			!candidates.some(
				(other, later) => later > index && other.tree === candidate.tree,
			),
	);
	const scores = scoreCandidates(distinct, runs);
	const byN = new Map(distinct.map((candidate) => [candidate.n, candidate]));
	const key = (score: CandidateScore) => [
		score.crossScore ?? score.verdictScore,
		VERDICT_RANK[byN.get(score.n)?.verdict ?? "fail"] *
			(byN.get(score.n)?.verdict ? 1 : 0),
		score.verdictScore,
		score.n,
	];
	const ranked = [...scores].sort((left, right) => {
		const a = key(left);
		const b = key(right);
		for (let index = 0; index < a.length; index++)
			if (a[index] !== b[index]) return b[index] - a[index];
		return 0;
	});
	const [first, second] = ranked;
	const close = (left: number, right: number) => Math.abs(left - right) < 1e-9;
	const tie =
		!!second &&
		close(
			first.crossScore ?? first.verdictScore,
			second.crossScore ?? second.verdictScore,
		) &&
		close(first.verdictScore, second.verdictScore);
	const scoreText = (score: CandidateScore) =>
		score.crossScore === null
			? `verdict ${score.verdictScore.toFixed(2)}`
			: `${(score.crossScore * 100).toFixed(0)}% of ${score.suitesRun} suite(s)`;
	return {
		best: first.n,
		runnerUp: second?.n ?? null,
		tie,
		scores,
		reason: `attempt ${first.n} (${scoreText(first)})${second ? ` over attempt ${second.n} (${scoreText(second)})` : ""}${tie ? ", tied" : ""}`,
	};
}

// ---------------------------------------------------------------------------
// Accounting.

const USAGE_FIELDS = [
	"inputTokens",
	"outputTokens",
	"uncachedInputTokens",
	"cacheReadTokens",
	"cacheWriteTokens",
] as const;

/** `after - before` per field (a field unknown on either side stays unknown). */
export function usageSince(
	after: ApiTokenUsage | null | undefined,
	before: ApiTokenUsage | null | undefined,
): ApiTokenUsage | null {
	if (!after) return null;
	if (!before) return after;
	const delta = Object.fromEntries(
		USAGE_FIELDS.map((field) => [
			field,
			after[field] === null || before[field] === null
				? null
				: Math.max(0, (after[field] ?? 0) - (before[field] ?? 0)),
		]),
	) as ApiTokenUsage;
	if (typeof after.costUsd === "number" && typeof before.costUsd === "number")
		return { ...delta, costUsd: Math.max(0, after.costUsd - before.costUsd) };
	return after.costUsd === undefined ? delta : { ...delta, costUsd: null };
}

export type AttemptSpend = {
	readonly tokens: number;
	readonly costUsd: number | null;
	/** costUsd is a list-price estimate (plan-billed route). */
	readonly estimated: boolean;
};

export function addSpend(
	left: AttemptSpend,
	right: AttemptSpend | null | undefined,
): AttemptSpend {
	if (!right) return left;
	return {
		tokens: left.tokens + right.tokens,
		costUsd:
			left.costUsd === null || right.costUsd === null
				? null
				: left.costUsd + right.costUsd,
		estimated: left.estimated || right.estimated,
	};
}

export const NO_ATTEMPT_SPEND: AttemptSpend = {
	tokens: 0,
	costUsd: 0,
	estimated: false,
};

// ---------------------------------------------------------------------------
// Checker accuracy (the hard-set report): the checker's verdict per attempt
// against the real grader's result for that attempt's candidate.

export type CheckerAccuracyRow = {
	readonly verdict: AttemptVerdictKind;
	readonly graderPassed: boolean;
};

export type CheckerAccuracy = {
	readonly n: number;
	readonly confusion: Record<
		AttemptVerdictKind,
		{ readonly graderPassed: number; readonly graderFailed: number }
	>;
	/** Decisive verdicts (pass/fail) that matched the grader, over decisive verdicts. */
	readonly agreement: number | null;
	/** Of the checker's passes, the share the grader failed (a wrong early stop). */
	readonly falsePassRate: number | null;
	/** Of the checker's fails, the share the grader passed (a wasted retry). */
	readonly falseFailRate: number | null;
	readonly unsureRate: number | null;
};

export function checkerAccuracy(
	rows: readonly CheckerAccuracyRow[],
): CheckerAccuracy {
	const confusion = {
		pass: { graderPassed: 0, graderFailed: 0 },
		fail: { graderPassed: 0, graderFailed: 0 },
		unsure: { graderPassed: 0, graderFailed: 0 },
	};
	for (const row of rows)
		confusion[row.verdict][
			row.graderPassed ? "graderPassed" : "graderFailed"
		]++;
	const passes = confusion.pass.graderPassed + confusion.pass.graderFailed;
	const fails = confusion.fail.graderPassed + confusion.fail.graderFailed;
	const ratio = (part: number, whole: number) => (whole ? part / whole : null);
	return {
		n: rows.length,
		confusion,
		agreement: ratio(
			confusion.pass.graderPassed + confusion.fail.graderFailed,
			passes + fails,
		),
		falsePassRate: ratio(confusion.pass.graderFailed, passes),
		falseFailRate: ratio(confusion.fail.graderPassed, fails),
		unsureRate: ratio(
			confusion.unsure.graderPassed + confusion.unsure.graderFailed,
			rows.length,
		),
	};
}

export function formatCheckerAccuracy(accuracy: CheckerAccuracy) {
	const percent = (value: number | null) =>
		value === null ? "-" : `${(value * 100).toFixed(0)}%`;
	const { confusion } = accuracy;
	return [
		`Checker accuracy over ${accuracy.n} graded attempt(s): agreement ${percent(accuracy.agreement)} (pass/fail verdicts), false-pass ${percent(accuracy.falsePassRate)} (grader failed a checker pass), false-fail ${percent(accuracy.falseFailRate)} (grader passed a checker fail), unsure ${percent(accuracy.unsureRate)}.`,
		`  checker pass:   grader pass ${confusion.pass.graderPassed}, grader fail ${confusion.pass.graderFailed}`,
		`  checker fail:   grader pass ${confusion.fail.graderPassed}, grader fail ${confusion.fail.graderFailed}`,
		`  checker unsure: grader pass ${confusion.unsure.graderPassed}, grader fail ${confusion.unsure.graderFailed}`,
	].join("\n");
}

// ---------------------------------------------------------------------------
// The loop's durable state (one per root turn, stored with the session).

/** A working tree captured as a commit (conversation-code-checkpoint's shape). */
export type AttemptSnapshot = {
	readonly cwd: string;
	readonly tree: string;
	readonly indexTree: string;
	readonly head: string;
	readonly ref: string;
};

export type AttemptCandidate = {
	readonly n: number;
	readonly startedAt: number;
	readonly endedAt: number;
	readonly snapshot: AttemptSnapshot;
	/** Ended by the loop's deadline before the builder finished. */
	readonly cutOff: boolean;
	/** The builder's final message for this attempt (excerpt). */
	readonly report: string;
	readonly builderUsage: ApiTokenUsage | null;
	readonly checker: {
		readonly sessionId: string;
		readonly startedAt: number;
		readonly endedAt?: number;
		readonly directory: string;
		readonly usage?: ApiTokenUsage | null;
	} | null;
	readonly verdict: CheckerVerdict | null;
	readonly checkMs?: number;
	readonly reset?: ResetReport;
};

export type AttemptSelectionRecord = {
	readonly reason: "attempts" | "time" | "tokens" | "pass";
	readonly runs: readonly SuiteRun[];
	readonly scores: readonly CandidateScore[];
	readonly best: number;
	readonly runnerUp: number | null;
	readonly tie: boolean;
	readonly judge?: {
		readonly sessionId: string;
		readonly winner: number | null;
		readonly usage?: ApiTokenUsage | null;
	};
	readonly explanation: string;
	readonly notes: readonly string[];
};

export type AttemptLoopPhase = "attempting" | "checking" | "judging" | "done";

export type AttemptLoopState = {
	readonly version: 1;
	readonly turnId: string;
	readonly max: number;
	readonly phase: AttemptLoopPhase;
	/** The attempt running now (or last run once done). */
	readonly attempt: number;
	readonly startedAt: number;
	readonly deadlineAt: number;
	readonly tokenBudget: number;
	readonly checkpoint: AttemptSnapshot;
	/** Listening process ids when the loop started (servers the attempt did not start). */
	readonly listenersAtStart: readonly number[];
	/** How many model messages precede the first attempt (request + turn-start context). */
	readonly baseMessageCount: number | null;
	/** sha256 of those messages: a compaction since changes it. */
	readonly baseMessageHash?: string | null;
	readonly attemptStartedAt: number;
	/** The turn's usage when the running attempt started. */
	readonly usageAtAttemptStart: ApiTokenUsage | null;
	readonly candidates: readonly AttemptCandidate[];
	readonly selection?: AttemptSelectionRecord;
	/** The attempt kept, once done. */
	readonly kept?: number;
	readonly finishedAt?: number;
};

export function meanAttemptStats(state: AttemptLoopState) {
	const done = state.candidates.filter((candidate) => !candidate.cutOff);
	if (!done.length) return { ms: 0, tokens: 0 };
	const ms =
		done.reduce(
			(sum, candidate) =>
				sum +
				(candidate.checker?.endedAt ?? candidate.endedAt) -
				candidate.startedAt,
			0,
		) / done.length;
	const tokens =
		done.reduce(
			(sum, candidate) =>
				sum +
				(candidate.builderUsage?.inputTokens ?? 0) +
				(candidate.builderUsage?.outputTokens ?? 0) +
				(candidate.checker?.usage?.inputTokens ?? 0) +
				(candidate.checker?.usage?.outputTokens ?? 0),
			0,
		) / done.length;
	return { ms, tokens };
}

export function loopTokens(state: AttemptLoopState) {
	return state.candidates.reduce(
		(sum, candidate) =>
			sum +
			(candidate.builderUsage?.inputTokens ?? 0) +
			(candidate.builderUsage?.outputTokens ?? 0) +
			(candidate.checker?.usage?.inputTokens ?? 0) +
			(candidate.checker?.usage?.outputTokens ?? 0),
		0,
	);
}

/** One line per attempt for the chat and the eval record. */
export function attemptLoopSummary(state: AttemptLoopState) {
	const lines = state.candidates.map((candidate) => {
		const verdict = candidate.verdict
			? `${candidate.verdict.verdict}${candidate.verdict.failures.length ? ` (${candidate.verdict.failures.length} finding${candidate.verdict.failures.length === 1 ? "" : "s"})` : ""}`
			: candidate.cutOff
				? "cut off, unchecked"
				: "unchecked";
		return `Attempt ${candidate.n}: ${verdict}${state.kept === candidate.n ? " · kept" : ""}`;
	});
	return lines.join("\n");
}
