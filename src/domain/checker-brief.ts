import { checkerJudgeSection, previousFindingsSection } from "./checker-pair";
import {
	type CheckerVerdict,
	parseCheckerVerdict,
	UNTESTED_PASS_NOTE,
	verdictRecords,
} from "./checker-verdict";

/**
 * The independent checker's review brief, in one place: the checker detection
 * test (scripts/checker-detect.ts), the review loop (review=on), the
 * builder's own checker subagent and the attempt loop's checker all use it.
 * It is generic on purpose: nothing in it names a task, a domain or a known
 * failure, and it gets only the user's request verbatim and the deliverable,
 * never the builder's transcript, report or reasoning.
 */

export type ReviewBriefInput = {
	/** The user's request, verbatim. */
	readonly taskText: string;
	/** The working directory that holds the deliverable. */
	readonly checkout: string;
	/** Files the run changed in the checkout, relative to it (git status). */
	readonly changedFiles: readonly string[];
	/** Files the run delivered outside the checkout (absolute paths). */
	readonly outsideFiles?: readonly string[];
	/** Where the checker may write (copies, scripts, scratch inputs). */
	readonly scratch: string;
	/** A command that shows the whole change (e.g. a git diff between two refs). */
	readonly diffCommand?: string;
	/** Harness variant rigor=on: the stated-assumption, outside-run and admitted-gap checks. */
	readonly rigor?: boolean;
	/**
	 * rigor=on: the builder's own requirements list (src/domain/rigor.ts), a
	 * claim the checker compares with its own list after deriving that.
	 */
	readonly builderRequirements?: readonly string[];
	/**
	 * Harness variant checkerMode=pair: the checker is a judge that briefs a
	 * worker for the reading and test runs (src/domain/checker-pair.ts).
	 */
	readonly pair?: boolean;
	/**
	 * checkerMode=pair: the earlier review rounds' findings, as context for a
	 * round that is still a full check.
	 */
	readonly previousFindings?: readonly string[];
};

/** rigor=on: stated interpretations get the convention-based reading tested. */
const RIGOR_ASSUMPTIONS =
	" Also look in the deliverable (files, comments, docs, output) for assumptions or interpretations it states. For each, work out the reading the convention of the library, ecosystem or standard involved gives (else the strictest reading) and test the deliverable under it. A numeric result at the edge of a stated threshold is a risk; say so.";

/** rigor=on: one run the way an outside user would run it. */
const RIGOR_OUTSIDE_RUN =
	" Run it once as an outside user would: a fresh shell in a clean directory holding only the files the request names, no dependencies or data files the request does not provide or declare, and results read back with standard clients and tools, never helpers the builder wrote.";

/** rigor=on with the builder's list: compare it only after the checker's own list. */
const RIGOR_COMPARE =
	" Then, and only then, compare your list with the builder's understanding of the requirements at the end of this brief: it is the builder's claim, not ground truth, and may be wrong or incomplete. Each requirement its list missed or read differently from the request is a failure when the deliverable falls short of the request's reading (say which reading the request supports), else a line in notes; never drop one of yours because the builder's list lacks it.";

/** rigor=on: a deliverable that admits a gap is not a pass. */
const RIGOR_ADMITTED =
	" A deliverable that itself admits unverified, failing or skipped parts (in its files, notes or output) is fail, or unsure when you could not check those parts; never pass.";

const MAX_LISTED_FILES = 200;

function deliverableLine(input: ReviewBriefInput) {
	const changed = input.changedFiles.slice(0, MAX_LISTED_FILES);
	const outside = (input.outsideFiles ?? []).slice(0, MAX_LISTED_FILES);
	return [
		`The working directory ${input.checkout}${changed.length ? `; files changed by the run: ${changed.join(", ")}${input.changedFiles.length > changed.length ? ", ..." : ""}` : " (no changed files recorded)"}.`,
		...(outside.length
			? [`Files the run delivered outside it: ${outside.join(", ")}.`]
			: []),
		...(input.diffCommand
			? [`\`${input.diffCommand}\` shows the whole change.`]
			: []),
	].join(" ");
}

/** The review a checker runs on a finished deliverable; returns {verdict, failures[], tests[]} JSON. */
export function independentReviewBrief(input: ReviewBriefInput) {
	const work = `${input.scratch}/work`;
	const rigor = !!input.rigor;
	const claimed = rigor ? (input.builderRequirements ?? []) : [];
	return [
		"You are an independent checker. Decide whether the delivered work meets the request below. You did not build it and nobody will tell you what to look for. A strict grader with hidden tests judges it after you, from the request alone, so look for what such a grader would check and what would make it fail.",
		"",
		"<request>",
		input.taskText,
		"</request>",
		"",
		"<deliverable>",
		deliverableLine(input),
		"</deliverable>",
		"",
		`Do not change the deliverable. Copy the checkout's contents (\`mkdir -p ${work} && cp -a ${input.checkout}/. ${work}/\`; the trailing /. copies what the path points to, even when it is a symbolic link) and run experiments only in ${input.scratch}; read the original paths where the request names them.`,
		"",
		"Review in four parts:",
		`1. Requirements. List every requirement in the request and in the files it points to (specs, READMEs, schemas, API docs, examples, format notes in the working directory): exact names, paths, formats, fields, values, units, ordering, limits, invocation and side effects such as records saved in a service. For each, give evidence that it is met or not: a command and its output, or a file and line. A requirement you could not check is not met.${claimed.length ? RIGOR_COMPARE : ""}`,
		`2. Assumptions. List the assumptions the deliverable depends on: readings of ambiguous wording, conventions, units, defaults, tie-breaking, interpretation of the inputs. Where a result hinges on one, work out the alternative reading and test it, and say which one the request and its files support.${rigor ? RIGOR_ASSUMPTIONS : ""}`,
		"3. Plausibility. Check that outputs are plausible: magnitudes, counts and ranges against the inputs, internal consistency, totals that add up, no placeholders, hard-coded or degenerate answers, and nothing that only works on the examples.",
		`4. Test it yourself. The project's existing tests passed for the builder too and are not enough: a strict grader's hidden tests target what they miss. For each requirement and each risky change in the diff, write at least one new test or executable probe of your own under ${input.scratch}/tests, aimed at cases the existing tests do not cover (derive them from the request, the diff and the files it points to): boundaries, empty and large inputs, error paths, ordering, concurrency and the states between steps. Use the stated paths, formats and invocation exactly, from a clean shell and another directory, without anything the builder may have left. Run your tests against your copy, then the existing tests and the callers of anything changed. Mark a test "probe": true when it goes beyond what the request and its files state (inputs, sizes, cases or guarantees they do not ask for); a failed probe is a note, not a failure.${rigor ? RIGOR_OUTSIDE_RUN : ""}`,
		...(claimed.length
			? [
					"",
					"<builder_requirements>",
					"The builder's understanding of the requirements, written before it worked (a claim to compare, not ground truth):",
					...claimed.map((line) => `- ${line}`),
					"</builder_requirements>",
				]
			: []),
		...(input.pair
			? ["", checkerJudgeSection({ scratch: input.scratch, work })]
			: []),
		...(input.pair && input.previousFindings?.length
			? ["", previousFindingsSection(input.previousFindings)]
			: []),
		"",
		"Answer with only this JSON:",
		'{ "verdict": "pass" | "fail" | "unsure", "failures": ["<requirement or assumption>: <what is wrong, with evidence>"], "tests": [{ "name": "<what it checks>", "command": "<one command that runs it, absolute paths>", "passed": true, "probe": false, "output": "<the lines that show the result>" }], "requirements": [{ "requirement": "...", "met": true, "evidence": "..." }], "assumptions": [{ "assumption": "...", "alternative": "...", "outcome": "..." }], "notes": "..." }',
		`"tests" lists only the tests and probes you wrote, each run. pass when every stated requirement is met with evidence and your non-probe tests and the existing checks pass; a pass without new tests of your own counts as unsure. fail only when the deliverable breaks something the request or its files state, shown by a failing test or command: name each in failures, most important first, with that evidence. Your own re-derivation of an answer is not evidence by itself: before failing on a disagreement, check it against the request's own files, examples and tools; if you cannot settle which is right, put it in notes. Probe failures, style and robustness beyond the request go in notes. unsure only when you genuinely could not run what matters; say why in notes.${rigor ? RIGOR_ADMITTED : ""}`,
	].join("\n");
}

/**
 * The user's standing rules for the project (from memory: instructions the
 * user gave in earlier chats), shown to a checker after its brief. Unlike the
 * builder's requirements list they are the user's own words, so the
 * deliverable must follow each one that applies.
 */
export function checkerStandingRules(input: {
	readonly rules: readonly string[];
	/** Other remembered lines that may bear on the request (data, may be outdated). */
	readonly related?: readonly string[];
}) {
	const related = input.related ?? [];
	return [
		...(input.rules.length
			? [
					"<standing_rules>",
					"The user's standing rules for this project, which the user gave in earlier chats. They are the user's instructions, not the builder's claims: add \"follows the project's remembered rules\" to your requirements, and check each rule below that applies to this deliverable as its own requirement with evidence. A deliverable that breaks one fails unless the request itself says otherwise.",
					...input.rules.map((rule) => `- ${rule}`),
					"</standing_rules>",
				]
			: []),
		...(related.length
			? [
					...(input.rules.length ? [""] : []),
					"<remembered>",
					"Other lines from the user's memory that may bear on this request (saved in earlier chats; may be outdated, the later `added:` date wins). Check any that states a rule for this deliverable like the standing rules:",
					...related,
					"</remembered>",
				]
			: []),
	].join("\n");
}

/** The user's request inside a review brief (independentReviewBrief), or null. */
export function reviewBriefRequest(brief: string): string | null {
	const open = "<request>\n";
	const start = brief.indexOf(open);
	const end = brief.indexOf("\n</request>\n\n<deliverable>");
	if (start < 0 || end < start) return null;
	return brief.slice(start + open.length, end);
}

export type ReviewRequirement = {
	readonly requirement: string;
	readonly met: boolean | null;
	readonly evidence: string;
};

export type ReviewAssumption = {
	readonly assumption: string;
	readonly alternative: string;
	readonly outcome: string;
};

export type ReviewVerdict = CheckerVerdict & {
	readonly requirements: readonly ReviewRequirement[];
	readonly assumptions: readonly ReviewAssumption[];
	/** The checker said pass without a test of its own (counted as unsure). */
	readonly untested?: boolean;
};

export { UNTESTED_PASS_NOTE };

const clip = (value: unknown, max: number) =>
	typeof value === "string" ? value.trim().slice(0, max) : "";

/**
 * The checker's answer: the verdict and failures as the product parses them
 * (a "pass" that lists failures, or names no new test of its own, is unsure;
 * no JSON is unsure), plus the requirement and assumption lists and the tests
 * it wrote.
 */
export function parseReviewVerdict(report: string): ReviewVerdict {
	const base = parseCheckerVerdict(report);
	const record = base.parsed
		? (verdictRecords(report)[0]?.record ?? null)
		: null;
	const requirements = Array.isArray(record?.requirements)
		? record.requirements.slice(0, 200).flatMap((entry) => {
				if (!entry || typeof entry !== "object") return [];
				const value = entry as Record<string, unknown>;
				const requirement = clip(value.requirement, 400);
				if (!requirement) return [];
				return [
					{
						requirement,
						met: typeof value.met === "boolean" ? value.met : null,
						evidence: clip(value.evidence, 800),
					},
				];
			})
		: [];
	const assumptions = Array.isArray(record?.assumptions)
		? record.assumptions.slice(0, 50).flatMap((entry) => {
				if (!entry || typeof entry !== "object") return [];
				const value = entry as Record<string, unknown>;
				const assumption = clip(value.assumption, 400);
				if (!assumption) return [];
				return [
					{
						assumption,
						alternative: clip(value.alternative, 400),
						outcome: clip(value.outcome, 600),
					},
				];
			})
		: [];
	// Unmet requirements count as failures when the checker listed none.
	const failures = base.failures.length
		? base.failures
		: requirements
				.filter((entry) => entry.met === false)
				.map((entry) =>
					entry.evidence
						? `${entry.requirement}: ${entry.evidence}`
						: entry.requirement,
				)
				.slice(0, 20);
	// Re-running the existing tests is not enough for a pass (see the brief).
	const untested =
		base.verdict === "pass" && !failures.length && !base.tests.length;
	return {
		...base,
		verdict:
			base.verdict === "pass" && (failures.length || untested)
				? "unsure"
				: base.verdict,
		failures,
		requirements,
		assumptions,
		...(untested
			? {
					untested: true,
					notes: `${UNTESTED_PASS_NOTE}${base.notes ? ` ${base.notes}` : ""}`,
				}
			: {}),
	};
}

/**
 * How long before a checker's time limit it is told to answer: a fifth of its
 * time, at least 90 seconds, at most half (its verdict JSON takes a minute to
 * write).
 */
export function checkerWrapUpLeadMs(budgetMs: number) {
	return Math.min(budgetMs / 2, Math.max(90_000, budgetMs * 0.2));
}

/** The runtime notice near a checker's time limit: answer now, with the JSON. */
export function checkerDeadlineNotice(secondsLeft: number) {
	return `Runtime notice, not a new request: about ${Math.max(0, Math.round(secondsLeft))} seconds are left for this check. Stop investigating now and answer with only the JSON your brief asks for, listing the tests you wrote and ran; a requirement you could not check is not met (say so in its evidence).`;
}
