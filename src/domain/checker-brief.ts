import {
	type CheckerVerdict,
	parseCheckerVerdict,
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
};

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

/** The review a checker runs on a finished deliverable; returns {verdict, failures[]} JSON. */
export function independentReviewBrief(input: ReviewBriefInput) {
	const work = `${input.scratch}/work`;
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
		`Do not change the deliverable. Copy what you need (\`cp -a ${input.checkout} ${work}\`) and run experiments only in ${input.scratch}; read the original paths where the request names them.`,
		"",
		"Review in four parts:",
		"1. Requirements. List every requirement in the request and in the files it points to (specs, READMEs, schemas, API docs, examples, format notes in the working directory): exact names, paths, formats, fields, values, units, ordering, limits, invocation and side effects such as records saved in a service. For each, give evidence that it is met or not: a command and its output, or a file and line. A requirement you could not check is not met.",
		"2. Assumptions. List the assumptions the deliverable depends on: readings of ambiguous wording, conventions, units, defaults, tie-breaking, interpretation of the inputs. Where a result hinges on one, work out the alternative reading and test it, and say which one the request and its files support.",
		"3. Plausibility. Check that outputs are plausible: magnitudes, counts and ranges against the inputs, internal consistency, totals that add up, no placeholders, hard-coded or degenerate answers, and nothing that only works on the examples.",
		"4. Exercise it as an outside grader would. Use the stated paths, formats and invocation exactly, from a clean shell and another directory, without scratch files, caches or environment the builder may have left. Try fresh inputs and edge cases a strict grader would use, and run the existing tests and callers of anything that was changed.",
		"",
		"Answer with only this JSON:",
		'{ "verdict": "pass" | "fail" | "unsure", "failures": ["<requirement or assumption>: <what is wrong, with evidence>"], "requirements": [{ "requirement": "...", "met": true, "evidence": "..." }], "assumptions": [{ "assumption": "...", "alternative": "...", "outcome": "..." }], "notes": "..." }',
		"pass only when every requirement is met with evidence and nothing the request needs is missing or wrong; fail when something required is wrong or missing (name each in failures, most important first); unsure when you could not check what matters.",
	].join("\n");
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
};

const clip = (value: unknown, max: number) =>
	typeof value === "string" ? value.trim().slice(0, max) : "";

/**
 * The checker's answer: the verdict and failures as the product parses them
 * (a "pass" that lists failures is unsure; no JSON is unsure), plus the
 * requirement and assumption lists the review asks for.
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
	return {
		...base,
		verdict:
			base.verdict === "pass" && failures.length ? "unsure" : base.verdict,
		failures,
		requirements,
		assumptions,
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
	return `Runtime notice, not a new request: about ${Math.max(0, Math.round(secondsLeft))} seconds are left for this check. Stop investigating now and answer with only the JSON your brief asks for; a requirement you could not check is not met (say so in its evidence).`;
}
