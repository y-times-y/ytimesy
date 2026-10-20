import type { ApiTokenUsage } from "./api-token-usage";
import type { AttemptSnapshot, LoopChildModel } from "./attempt-loop";
import type { ReviewVerdict } from "./checker-brief";
import { type CheckerTest, NO_VERDICT_FAILURE } from "./checker-verdict";

/**
 * The review loop (harness variant review=on, decision 2026-10-18 "A"):
 * when the root builder declares its turn complete, an independent checker
 * reviews the delivered work against the user's request (the shared brief in
 * checker-brief.ts). A pass finishes the turn. Concrete findings are handed
 * back to the same builder run as one runtime notice ("verify each; fix the
 * real ones; say which you reject"), up to two review rounds per turn. No
 * reset, no candidates. These are the pure rules; the runtime is
 * src/server/services/review-loop.ts.
 */

export const REVIEW_LOOP_LIMITS = {
	/** Checks per turn; each check with concrete findings is followed by one fix. */
	maxRounds: 2,
	/** Wall time for a turn's reviews and fixes in the product (a runner's deadline only shortens it). */
	loopMinutes: 60,
	checker: { steps: 60, minutes: 10, tokens: 800_000 },
	/** What a check is expected to take before one has been timed in this turn. */
	expectedCheckMs: 150_000,
	/** The least time a fix needs after its check. */
	minFixMs: 60_000,
	/** Product gating: a turn that ran at least this long is reviewed even without a runnable deliverable. */
	minTurnMs: 3 * 60_000,
	/** Findings handed to the builder per round (most important first). */
	maxFindings: 8,
	/** Assumptions handed over per round (after failures and unmet requirements). */
	maxAssumptions: 3,
	/** The checker's failing tests handed over per round, to reproduce its findings. */
	maxFailingTests: 5,
} as const;

/** Files that run: code, scripts, build and service definitions. */
const RUNNABLE =
	/(\.(py|js|mjs|cjs|ts|tsx|jsx|sh|bash|rb|go|rs|java|kt|c|cc|cpp|h|hpp|cs|php|pl|lua|r|jl|swift|scala|sql|ipynb|toml|ya?ml)|(^|\/)(Makefile|Dockerfile|Justfile|package\.json|Cargo\.toml|go\.mod|pyproject\.toml|requirements[^/]*\.txt))$/i;

export const isRunnableFile = (path: string) => RUNNABLE.test(path.trim());

export type ReviewEligibility =
	| { readonly review: true }
	| { readonly review: false; readonly reason: string };

/**
 * Product gating for a finished turn: only a turn that changed files, and
 * either ran long enough to be real work or delivered something runnable.
 * (Plan mode, subagents and read-only turns never get a loop at all.)
 */
export function reviewEligibility(input: {
	readonly changedFiles: readonly string[];
	readonly turnMs: number;
}): ReviewEligibility {
	if (!input.changedFiles.length)
		return { review: false, reason: "no files changed" };
	if (
		input.turnMs < REVIEW_LOOP_LIMITS.minTurnMs &&
		!input.changedFiles.some(isRunnableFile)
	)
		return {
			review: false,
			reason: "a short turn without a runnable deliverable",
		};
	return { review: true };
}

/** One finding handed to the builder, numbered F1, F2, ... */
export type ReviewFinding = {
	readonly id: string;
	/** unverified: the builder's own final answer admitted unverified work (rigor=on). */
	readonly kind: "failure" | "requirement" | "assumption" | "unverified";
	readonly text: string;
};

/** rigor=on: the finding for a final answer that admits unverified work with time left. */
function unverifiedText(admitted: readonly string[]) {
	return `Your final answer admits unverified or open work while over half of the time is left: ${admitted.map((line) => `"${line}"`).join("; ")}. Verify or fix it now; report as unverified only what cannot be checked here.`;
}

const RUNTIME_FAILURES = new Set([
	NO_VERDICT_FAILURE,
	"The independent check did not finish before the deadline.",
]);

const clip = (value: string, max: number) =>
	value.length > max ? `${value.slice(0, max - 3)}...` : value;

/**
 * The checker's specific findings, most important first: its failures, the
 * unmet requirements it did not already list, then the assumptions it
 * examined (alternative and outcome), as evidence to weigh. With rigor=on an
 * admission of unverified work in the builder's answer comes first.
 */
export function reviewFindings(
	verdict: ReviewVerdict,
	/** rigor=on: lines of the builder's final answer that admit unverified work. */
	admitted: readonly string[] = [],
): ReviewFinding[] {
	const failures = verdict.failures.filter(
		(failure) => !RUNTIME_FAILURES.has(failure),
	);
	const unmet = verdict.requirements
		.filter((entry) => entry.met === false)
		.map((entry) =>
			entry.evidence
				? `${entry.requirement}: ${entry.evidence}`
				: entry.requirement,
		)
		.filter(
			(text) =>
				!failures.some(
					(failure) =>
						failure === text || failure.startsWith(text.split(":")[0] ?? text),
				),
		);
	const concrete = [
		...(admitted.length
			? [{ kind: "unverified" as const, text: unverifiedText(admitted) }]
			: []),
		...failures.map((text) => ({ kind: "failure" as const, text })),
		...unmet.map((text) => ({ kind: "requirement" as const, text })),
	].slice(0, REVIEW_LOOP_LIMITS.maxFindings);
	const assumptions = concrete.length
		? verdict.assumptions
				.slice(0, REVIEW_LOOP_LIMITS.maxAssumptions)
				.map((entry) => ({
					kind: "assumption" as const,
					text: [
						`Assumption: ${entry.assumption}`,
						entry.alternative ? `alternative: ${entry.alternative}` : "",
						entry.outcome ? `checker's outcome: ${entry.outcome}` : "",
					]
						.filter(Boolean)
						.join("; "),
				}))
		: [];
	return [...concrete, ...assumptions].map((finding, index) => ({
		id: `F${index + 1}`,
		kind: finding.kind,
		text: clip(finding.text, 900),
	}));
}

/** Findings the builder can act on: a failure or an unmet requirement (assumptions alone are not). */
export const hasConcreteFindings = (findings: readonly ReviewFinding[]) =>
	findings.some((finding) => finding.kind !== "assumption");

/** The checker's own tests that failed, with the command and output to reproduce each. */
export function failingTests(verdict: ReviewVerdict | null): CheckerTest[] {
	return (verdict?.tests ?? [])
		.filter((test) => !test.passed)
		.slice(0, REVIEW_LOOP_LIMITS.maxFailingTests);
}

function failingTestLine(test: CheckerTest) {
	const output = test.output ?? test.evidence;
	return [
		`- ${clip(test.name, 200)}`,
		test.command ? `: \`${clip(test.command, 500)}\`` : "",
		output ? ` -> ${clip(output.replace(/\s*\n\s*/g, " | "), 600)}` : "",
	].join("");
}

/**
 * The one runtime notice a review round adds to the builder's own run: the
 * checker's findings with their evidence, the failing tests it wrote (command
 * and output, to reproduce them), and what to do with them.
 */
export function reviewNotice(input: {
	readonly round: number;
	readonly maxRounds: number;
	readonly findings: readonly ReviewFinding[];
	readonly failingTests?: readonly CheckerTest[];
}) {
	const tests = input.failingTests ?? [];
	return [
		`Runtime notice, not a new user request. An independent checker reviewed your work against the request above (review ${input.round} of ${input.maxRounds}). It saw only the request and the files, not your reasoning, and it can be wrong. Its findings:`,
		...input.findings.map((finding) => `${finding.id}. ${finding.text}`),
		...(tests.length
			? [
					"Tests it wrote that failed (run each command to reproduce; the test itself may be wrong):",
					...tests.map(failingTestLine),
				]
			: []),
		"Verify each finding yourself. Fix the real ones and re-run what proves each fix; do not change correct work to satisfy a wrong finding. End your final answer with one line per finding: `F1: fixed` or `F1: rejected - <why>`.",
	].join("\n");
}

export type FindingResponses = {
	readonly fixed: readonly string[];
	readonly rejected: readonly {
		readonly id: string;
		readonly reason: string;
	}[];
	/** Findings the answer did not mention. */
	readonly unanswered: readonly string[];
};

/** The builder's `F1: fixed` / `F2: rejected - why` lines, per finding. */
export function findingResponses(
	answer: string,
	findings: readonly ReviewFinding[],
): FindingResponses {
	const fixed: string[] = [];
	const rejected: { id: string; reason: string }[] = [];
	for (const line of answer.split("\n")) {
		const match =
			/^\s*(?:[-*]\s*)?[*_`]*(F\d+)[*_`]*\s*[:.)-]\s*[*_`]*(fixed|rejected)[*_`]*\b\s*(?:[-:–—]\s*)?(.*)$/i.exec(
				line,
			);
		if (!match) continue;
		const id = match[1].toUpperCase();
		if (!findings.some((finding) => finding.id === id)) continue;
		if (fixed.includes(id) || rejected.some((entry) => entry.id === id))
			continue;
		if (match[2].toLowerCase() === "fixed") fixed.push(id);
		else rejected.push({ id, reason: match[3].trim().slice(0, 300) });
	}
	return {
		fixed,
		rejected,
		unanswered: findings
			.map((finding) => finding.id)
			.filter(
				(id) =>
					!fixed.includes(id) && !rejected.some((entry) => entry.id === id),
			),
	};
}

export type ReviewDecision =
	| { readonly kind: "check"; readonly checkMs: number }
	| {
			readonly kind: "finish";
			readonly reason: "rounds" | "time";
	  };

/**
 * Before a check: the turn's rounds and the time left decide. A check runs
 * only when the expected check plus a minimal fix still fit; it may then use
 * all the time but the fix's.
 */
export function decideCheck(input: {
	readonly checksDone: number;
	readonly now: number;
	readonly deadlineAt: number;
	/** Mean of this turn's earlier checks, else the default. */
	readonly expectedCheckMs: number;
}): ReviewDecision {
	if (input.checksDone >= REVIEW_LOOP_LIMITS.maxRounds)
		return { kind: "finish", reason: "rounds" };
	const available = input.deadlineAt - input.now;
	if (available < input.expectedCheckMs + REVIEW_LOOP_LIMITS.minFixMs)
		return { kind: "finish", reason: "time" };
	return {
		kind: "check",
		checkMs: Math.min(
			REVIEW_LOOP_LIMITS.checker.minutes * 60_000,
			available - REVIEW_LOOP_LIMITS.minFixMs,
		),
	};
}

export type ReviewOutcome =
	| "pass"
	| "no-findings"
	| "rounds"
	| "time"
	| "not-eligible"
	| "check-failed";

/**
 * After a verdict: pass finishes (unless the builder admitted unverified
 * work, rigor=on); concrete findings get a fix while time allows.
 */
export function decideAfterVerdict(input: {
	readonly verdict: ReviewVerdict;
	readonly findings: readonly ReviewFinding[];
	readonly now: number;
	readonly deadlineAt: number;
}):
	| { readonly kind: "fix" }
	| { readonly kind: "finish"; readonly reason: ReviewOutcome } {
	if (
		input.verdict.verdict === "pass" &&
		!input.findings.some((finding) => finding.kind === "unverified")
	)
		return { kind: "finish", reason: "pass" };
	if (!hasConcreteFindings(input.findings))
		return { kind: "finish", reason: "no-findings" };
	if (input.deadlineAt - input.now < REVIEW_LOOP_LIMITS.minFixMs)
		return { kind: "finish", reason: "time" };
	return { kind: "fix" };
}

// ---------------------------------------------------------------------------
// The loop's durable state (one per root turn, stored with the session).

export type ReviewRound = {
	readonly n: number;
	/** The tree the checker reviewed. */
	readonly snapshot: AttemptSnapshot;
	readonly changedFiles: number;
	readonly checker: {
		readonly sessionId: string;
		readonly startedAt: number;
		readonly budgetMs: number;
		readonly endedAt?: number;
		readonly usage?: ApiTokenUsage | null;
		/** The checker's own model (roleModels); absent = the builder's. */
		readonly model?: LoopChildModel;
	};
	readonly verdict: ReviewVerdict | null;
	readonly timedOut?: boolean;
	/** rigor=on: what the builder's final answer admitted, with over half the time left. */
	readonly admitted?: readonly string[];
	readonly findings: readonly ReviewFinding[];
	/** What followed the verdict. */
	readonly decision?: "fix" | ReviewOutcome;
	readonly fix?: {
		readonly startedAt: number;
		readonly usageAtStart: ApiTokenUsage | null;
		readonly endedAt?: number;
		readonly usage?: ApiTokenUsage | null;
		readonly responses?: FindingResponses;
	};
};

export type ReviewLoopPhase = "building" | "checking" | "fixing" | "done";

export type ReviewLoopState = {
	readonly version: 1;
	readonly kind: "review";
	readonly turnId: string;
	readonly phase: ReviewLoopPhase;
	readonly startedAt: number;
	readonly deadlineAt: number;
	/** The working tree before the builder's first step (the diff's base). */
	readonly checkpoint: AttemptSnapshot;
	readonly rounds: readonly ReviewRound[];
	readonly outcome?: ReviewOutcome;
	/** Why no (further) check ran. */
	readonly note?: string;
	readonly finishedAt?: number;
};

/** Mean wall time of this turn's finished checks, else the default. */
export function expectedCheckMs(state: ReviewLoopState) {
	const timed = state.rounds.filter((round) => round.checker.endedAt);
	if (!timed.length) return REVIEW_LOOP_LIMITS.expectedCheckMs;
	return (
		timed.reduce(
			(sum, round) =>
				sum + ((round.checker.endedAt ?? 0) - round.checker.startedAt),
			0,
		) / timed.length
	);
}

/** One line per round, for the chat and the eval record. */
export function reviewLoopSummary(state: ReviewLoopState) {
	const lines = state.rounds.map((round) => {
		const verdict = round.verdict
			? `${round.verdict.verdict}${round.findings.length ? ` (${round.findings.length} finding${round.findings.length === 1 ? "" : "s"})` : ""}`
			: round.timedOut
				? "no verdict in time"
				: "checking";
		const responses = round.fix?.responses;
		const fix =
			round.decision === "fix"
				? responses
					? ` · fixed ${responses.fixed.length}, rejected ${responses.rejected.length}${responses.unanswered.length ? `, unanswered ${responses.unanswered.length}` : ""}`
					: " · fixing"
				: "";
		return `Review ${round.n}: ${verdict}${fix}`;
	});
	if (state.outcome && state.outcome !== "pass")
		lines.push(
			`Review ended: ${state.outcome}${state.note ? ` (${state.note})` : ""}.`,
		);
	return lines.join("\n");
}
