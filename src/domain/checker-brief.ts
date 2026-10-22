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
	" Also look in the deliverable (files, comments, docs, output) for assumptions or interpretations it states. For each, work out the reading the convention of the library, ecosystem or standard involved gives (the strictest reading only when no convention applies) and test the deliverable under it. A numeric result at the edge of a stated threshold is a risk; say so.";

/** rigor=on: one run the way an outside user would run it. */
const RIGOR_OUTSIDE_RUN =
	" Run it once as an outside user would: a fresh shell in a clean directory holding only the files the request names, no dependencies or data files the request does not provide or declare, and results read back with standard clients and tools, never helpers the builder wrote.";

/** rigor=on with the builder's list: compare it only after the checker's own list. */
const RIGOR_COMPARE =
	" Then, and only then, compare your list with the builder's understanding of the requirements at the end of this brief: it is the builder's claim, not ground truth, and may be wrong or incomplete. Each requirement its list missed or read differently from the request is a failure when the deliverable falls short of the request's reading (say which reading the request supports), else a line in notes; never drop one of yours because the builder's list lacks it.";

/** rigor=on: a deliverable that admits a gap is not a pass. */
const RIGOR_ADMITTED =
	" A deliverable that itself admits unverified, failing or skipped parts (in its files, notes or output) is fail unless a run of yours shows those parts work.";

/**
 * An ambiguous request: run each plausible reading; when the outputs differ,
 * a fixed order of evidence decides, and a tie passes (user decision
 * 2026-10-22: the checker ends with pass or fail, never unsure).
 */
const AMBIGUITY =
	"Where a result hinges on one, run the deliverable or a script under each plausible reading. Equal outputs: not a finding. Different outputs: decide, in this order, by the request's own examples, sample data and existing tests (run the deliverable on them), then the convention of the library or standard involved, then the reading more consistent with the rest of the files; the losing reading is a failure only when a run shows the deliverable takes it (both readings, the output each gives). Still tied: not a failure; name both readings in notes.";

/** What cannot run here is replaced by the closest thing that can, never skipped. */
const STAND_IN =
	"When the real thing cannot run here (a missing service, GPU, data or network), build the closest runnable stand-in (a smaller input, a stub of the external service, the deliverable's own entry point on sample data) and verify against that. Never answer without running something.";

/** The checker's findings file: each verified result as it goes, so a cut-off check keeps its work. */
export const checkerFindingsPath = (scratch: string) =>
	`${scratch}/findings.jsonl`;

function findingsLine(scratch: string) {
	return `As you verify each point, append it as one JSON line to ${checkerFindingsPath(scratch)}: {"failure" or "requirement": "...", "met": true|false, "command": "<what you ran>", "output": "<what it printed>"}. If your time runs out, your verdict is built from this file.`;
}

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
		findingsLine(input.scratch),
		STAND_IN,
		"",
		"Review in four parts:",
		`1. Requirements. Before anything else, and before reading the deliverable's notes or rationale, list each symptom or requirement the request itself states and mark it fixed or not fixed by running a reproduction through the existing public API and entry points, the calls a normal caller makes (hidden tests use them). A stated symptom not fixed that way is a failure, whatever docstrings, comments or the deliverable's notes say; a fix that needs new methods, flags, protocols or extra caller calls does not fix it. Then list every other requirement in the files the request points to (specs, READMEs, schemas, API docs, examples, format notes in the working directory): exact names, paths, formats, fields, values, units, ordering, limits, invocation and side effects such as records saved in a service. For each, run a command that shows it is met or not (a file and line too: grep -n, not reading). A requirement you could not check is not met.${claimed.length ? RIGOR_COMPARE : ""}`,
		`2. Assumptions. Before reading any rationale the deliverable states, write and run a script under ${input.scratch}/tests that derives each key output from the governing rule or procedure in the request and its files (enumerated lists, precedence orders, required-type tables, the convention of the library or standard involved) and diffs it against the deliverable's. A mismatch that script shows, and the deliverable's reasoning does not refute from the source text, is a failure. An explicit list or precedence order beats general guidance such as "minimal" or "avoid redundancy". Then list the assumptions the deliverable depends on: readings of ambiguous wording, conventions, units, defaults, tie-breaking, interpretation of the inputs. ${AMBIGUITY}${rigor ? RIGOR_ASSUMPTIONS : ""}`,
		"3. Plausibility. Check that outputs are plausible: magnitudes, counts and ranges against the inputs, internal consistency, totals that add up, no placeholders, hard-coded or degenerate answers, and nothing that only works on the examples.",
		`4. Test it yourself. The project's existing tests passed for the builder too and are not enough: a strict grader's hidden tests target what they miss. For each requirement and each risky change in the diff, write at least one new test or executable probe of your own under ${input.scratch}/tests, aimed at cases the existing tests do not cover (derive them from the request, the diff and the files it points to): boundaries, empty and large inputs, error paths, ordering, concurrency and the states between steps. Keep \`${input.scratch}/tests/run.sh\` running all your non-probe tests (non-zero exit on a failure); the review loop runs it again after you. Use the stated paths, formats and invocation exactly, from a clean shell and another directory, without anything the builder may have left. Run your tests against your copy, then the existing tests and the callers of anything changed. Mark a test "probe": true when it goes beyond what the request and its files state (inputs, sizes, cases or guarantees they do not ask for); a failed probe is a note, not a failure.${rigor ? RIGOR_OUTSIDE_RUN : ""}`,
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
		'{ "verdict": "pass" | "fail", "failures": [{ "failure": "<requirement or assumption>: <what is wrong>", "command": "<the command you ran that shows it>", "output": "<what it printed>" }], "tests": [{ "name": "<what it checks>", "command": "<one command that runs it, absolute paths>", "passed": true, "probe": false, "output": "<the lines that show the result>" }], "requirements": [{ "requirement": "...", "met": true, "command": "<the command you ran to check it>", "output": "<what it printed>" }], "assumptions": [{ "assumption": "...", "alternative": "...", "outcome": "..." }], "notes": "..." }',
		`Verify by running, never by reading or reasoning alone: reproductions through the existing API, the deliverable itself, scripts that recompute expected outputs. Each failure and requirement cites the exact command or script you ran and what it printed; these are matched against the commands you actually ran, and a claim you did not execute is a note, not a finding. "tests" lists only the tests and probes you wrote, each run. The verdict is pass or fail, never anything else. pass when a command you ran shows each stated requirement met and your non-probe tests and the existing checks pass; a pass needs new tests of your own. fail only when a command you ran shows the deliverable breaking something the request or its files state: list each in failures, most important first. Probe failures, style and robustness beyond the request go in notes.${rigor ? RIGOR_ADMITTED : ""}`,
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
	/** What the check printed (the answer's "output"; older answers: "evidence"). */
	readonly evidence: string;
	/** The command the checker cites for it. */
	readonly command?: string;
};

/** The command a failure cites and what it printed ("" when it cites none). */
export type ReviewFailureEvidence = {
	readonly command: string;
	readonly output: string;
};

export type ReviewAssumption = {
	readonly assumption: string;
	readonly alternative: string;
	readonly outcome: string;
};

/** A review verdict is pass or fail, never unsure (user decision 2026-10-22). */
export type ReviewVerdictKind = "pass" | "fail";

/**
 * How a review verdict was reached, to measure: the checker's answer
 * (normal), its tool-less final step at its time limit (forced-final), its
 * findings file after a cut-off (findings-file), the review loop running
 * its tests (harness-grounded), a second check (retry), or nothing run to
 * show it (default-pass).
 */
export const VERDICT_VIA = [
	"normal",
	"forced-final",
	"findings-file",
	"harness-grounded",
	"retry",
	"default-pass",
] as const;
export type VerdictVia = (typeof VERDICT_VIA)[number];

/** A command the review loop ran itself after the check, and what it printed. */
export type HarnessRun = {
	readonly command: string;
	readonly exitCode: number;
	readonly output: string;
	/** The checker's non-probe test (or run.sh): a non-zero exit is a finding. */
	readonly test: boolean;
};

export type ReviewVerdict = Omit<CheckerVerdict, "verdict"> & {
	readonly verdict: ReviewVerdictKind;
	readonly requirements: readonly ReviewRequirement[];
	readonly assumptions: readonly ReviewAssumption[];
	/** The checker said pass without a test of its own (grounding decides). */
	readonly untested?: boolean;
	/** Per failure, in the same order: the command it cites and its output. */
	readonly failureEvidence?: readonly ReviewFailureEvidence[];
	/**
	 * The review loop's check of the evidence (checker-evidence.ts): findings
	 * no command the checker ran shows, set aside as notes.
	 */
	readonly downgraded?: readonly string[];
	/** A pass (or a fail left without findings) that nothing run verified: no verdict yet. */
	readonly ungrounded?: true;
	/** How the verdict was reached (set by the review loop). */
	readonly via?: VerdictVia;
	/** Commands the review loop ran itself to ground the verdict. */
	readonly harnessRuns?: readonly HarnessRun[];
};

/** A requirement as a finding: what, what the check printed, the command. */
export function requirementText(entry: ReviewRequirement) {
	return [
		entry.requirement,
		entry.evidence ? `: ${entry.evidence}` : "",
		entry.command ? ` (ran \`${entry.command}\`)` : "",
	].join("");
}

/** A failure the checker listed, as text, and the evidence it cites. */
function failureEntry(
	entry: unknown,
): { text: string; evidence: ReviewFailureEvidence } | null {
	if (typeof entry === "string") {
		const text = clip(entry, 600);
		return text ? { text, evidence: { command: "", output: "" } } : null;
	}
	if (!entry || typeof entry !== "object") return null;
	const value = entry as Record<string, unknown>;
	const what =
		clip(value.failure, 600) ||
		clip(value.finding, 600) ||
		clip(value.requirement, 600);
	if (!what) return null;
	const command = clip(value.command, 2000);
	const output = clip(value.output, 600) || clip(value.evidence, 600);
	return {
		text: [
			what,
			command ? ` (ran \`${command.slice(0, 300)}\`` : "",
			command && output ? ` -> ${output})` : command ? ")" : "",
			!command && output ? `: ${output}` : "",
		].join(""),
		evidence: { command, output },
	};
}

export { UNTESTED_PASS_NOTE };

const clip = (value: unknown, max: number) =>
	typeof value === "string" ? value.trim().slice(0, max) : "";

/**
 * The checker's answer: the verdict and failures as the product parses them,
 * plus the requirement and assumption lists and the tests it wrote. Only
 * pass or fail comes out: an older "unsure" (or a pass that lists failures)
 * is a fail when it lists failures, else a pass; grounding
 * (checker-evidence.ts) then keeps only what a run shows. No JSON is a fail
 * with parsed false, which the review loop treats as no verdict.
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
				const command = clip(value.command, 2000);
				return [
					{
						requirement,
						met: typeof value.met === "boolean" ? value.met : null,
						evidence: clip(value.output, 800) || clip(value.evidence, 800),
						...(command ? { command } : {}),
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
	// The failures it listed, else its failing tests, else (when it listed
	// none) its unmet requirements, each with the evidence it cites.
	const listed = Array.isArray(record?.failures)
		? record.failures.flatMap((entry) => failureEntry(entry) ?? [])
		: [];
	const failing = base.tests
		.filter((test) => !test.passed && !test.probe)
		.map((test) => {
			const output = test.evidence ?? test.output;
			return {
				text: output ? `${test.name}: ${output}` : test.name,
				evidence: { command: test.command ?? "", output: output ?? "" },
			};
		});
	const unmet = requirements
		.filter((entry) => entry.met === false)
		.map((entry) => ({
			text: requirementText(entry),
			evidence: { command: entry.command ?? "", output: entry.evidence },
		}));
	const entries = (
		!base.parsed
			? base.failures.map((text) => ({
					text,
					evidence: { command: "", output: "" },
				}))
			: listed.length
				? listed
				: failing.length
					? failing
					: unmet
	).slice(0, 20);
	const failures = entries.map((entry) => entry.text);
	// Re-running the existing tests is not enough for a pass (see the brief).
	const said = record?.verdict;
	const untested = said === "pass" && !failures.length && !base.tests.length;
	return {
		...base,
		verdict: !base.parsed || failures.length ? "fail" : "pass",
		failures,
		failureEvidence: entries.map((entry) => entry.evidence),
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
	return `Runtime notice, not a new request: about ${Math.max(0, Math.round(secondsLeft))} seconds are left for this check. Stop investigating now and answer with only the JSON your brief asks for, listing the tests you wrote and ran; a requirement you could not check is not met (say so in its output).`;
}

/** Within this long of a checker's time limit its next step is the forced final one. */
export const CHECKER_FINAL_STEP_LEAD_MS = 60_000;

/**
 * The forced final step's notice (tools are off for that step): the verdict
 * from what it ran. It is the start of the message, so a resumed step finds it.
 */
export const CHECKER_FINAL_NOTICE =
	"Final step, runtime notice: your time is up and tools are off. Answer now with only the JSON your brief asks for, pass or fail, from the commands you ran and what they printed (your findings file has what you recorded).";

/** Appended to a checker's report when its verdict came from the forced final step. */
export const CHECKER_FORCED_FINAL_MARK = "(verdict from the forced final step)";

/** Whether a checker's history already has its forced final notice. */
export const hasCheckerFinalNotice = (
	messages: readonly { role: string; content: unknown }[],
) =>
	messages.some(
		(message) =>
			message.role === "user" &&
			typeof message.content === "string" &&
			message.content.startsWith(CHECKER_FINAL_NOTICE.slice(0, 30)),
	);

/**
 * A checker's step guard decision on time: "final" when its time is up or
 * within CHECKER_FINAL_STEP_LEAD_MS of it and it has not had its final step,
 * "stop" when it has, else "go".
 */
export function checkerFinalStep(input: {
	readonly msLeft: number;
	/** Another limit (steps, tokens, a parent's stop) is used up. */
	readonly exhausted?: boolean;
	readonly hadFinal: boolean;
}): "go" | "final" | "stop" {
	const due = input.exhausted || input.msLeft <= CHECKER_FINAL_STEP_LEAD_MS;
	if (!due) return "go";
	return input.hadFinal ? "stop" : "final";
}

/**
 * A checker cut off before its answer (the bridge's last resort): its brief,
 * then the commands it ran and what they printed, then the final notice,
 * for one model call without tools.
 */
export function checkerFinalPrompt(input: {
	readonly brief: string;
	readonly ran: string;
	readonly findings: string;
}) {
	return [
		input.brief,
		"",
		"<what_you_ran>",
		input.ran.slice(-60_000) || "(nothing recorded)",
		"</what_you_ran>",
		...(input.findings.trim()
			? [
					"",
					"<findings_file>",
					input.findings.slice(-20_000),
					"</findings_file>",
				]
			: []),
		"",
		CHECKER_FINAL_NOTICE,
	].join("\n");
}

/**
 * The checker's findings file (one JSON line per verified result) as a
 * verdict: fail when any line shows a failure or an unmet requirement, else
 * pass; null when no line parses. Each line's command is grounded like an
 * answer's (checker-evidence.ts).
 */
export function findingsFileVerdict(contents: string): ReviewVerdict | null {
	const failures: string[] = [];
	const failureEvidence: ReviewFailureEvidence[] = [];
	const requirements: ReviewRequirement[] = [];
	for (const line of contents.split("\n")) {
		let value: Record<string, unknown>;
		try {
			value = JSON.parse(line.trim());
		} catch {
			continue;
		}
		if (!value || typeof value !== "object") continue;
		const command = clip(value.command, 2000);
		const output = clip(value.output, 800) || clip(value.evidence, 800);
		const failure = clip(value.failure, 600);
		const requirement = clip(value.requirement, 400);
		if (failure && value.met !== true) {
			const entry = failureEntry(value);
			if (entry) {
				failures.push(entry.text);
				failureEvidence.push(entry.evidence);
			}
		} else if (requirement)
			requirements.push({
				requirement,
				met: typeof value.met === "boolean" ? value.met : null,
				evidence: output,
				...(command ? { command } : {}),
			});
	}
	if (!failures.length && !requirements.length) return null;
	for (const entry of requirements.filter((entry) => entry.met === false)) {
		failures.push(requirementText(entry));
		failureEvidence.push({
			command: entry.command ?? "",
			output: entry.evidence,
		});
	}
	return {
		verdict: failures.length ? "fail" : "pass",
		failures: failures.slice(0, 20),
		failureEvidence: failureEvidence.slice(0, 20),
		tests: [],
		testsPath: null,
		notes:
			"(Built from the checker's findings file: it was cut off before its answer.)",
		parsed: true,
		requirements: requirements.slice(0, 200),
		assumptions: [],
	};
}
