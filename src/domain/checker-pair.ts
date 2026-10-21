import type { ReviewVerdict } from "./checker-brief";
import { type CheckerTest, UNTESTED_PASS_NOTE } from "./checker-verdict";
import type { SessionItem } from "./session-item";
import {
	MAX_SUBAGENT_LEVEL,
	SUBAGENT_LEVEL_LIMITS,
	type SubagentBudget,
	type SubagentRemaining,
} from "./subagent";

/**
 * The checker pair (harness variant checkerMode=pair): the checker's work
 * split like lead mode fusion's lead and sidekick. A strong judge
 * (roleModels.checker) gets the usual independent brief, plans the check,
 * briefs a cheaper worker (roleModels.checkerWorker) through one tool and
 * writes the verdict JSON itself; the worker, a read-only reader on the same
 * VM as the same reader user, does the reading, test writing and running in
 * the judge's scratch and reports compact evidence. Neither sees the
 * builder's conversation: the judge gets the runtime's brief, the worker
 * only the judge's briefs. Every review round starts a new judge with the
 * full brief (and the earlier rounds' findings for context), so each round
 * is a full independent check.
 */

/** The judge's tool that starts a worker (or briefs one again) and waits for its evidence. */
export const CHECKER_WORKER_TOOL = "checker_worker";

/** The judge's part of its brief: how the pair works. */
export function checkerJudgeSection(input: {
	readonly scratch: string;
	readonly work: string;
}) {
	return [
		"<checker_pair>",
		`You are the judge of a checker pair. A worker agent (a cheaper model, read-only like you, on this machine as the same user, with ${input.scratch} writable) does the reading, test writing and running for you; you plan the check, weigh the evidence and write the verdict. The four parts above are yours to cover in full; the worker carries out what you assign.`,
		`- Brief it with \`${CHECKER_WORKER_TOOL}\`: it sees only your brief (never the builder's conversation or this one), so make each brief self-contained: the request's relevant wording, the paths, what to read and summarize, the copy to make (\`${input.work}\`), which new tests and probes to write under ${input.scratch}/tests and run, which existing tests and callers to run, and the evidence to return. The call waits for its report.`,
		"- Ask for compact evidence, not narration: each command as run with its exit status and the output lines that matter, file:line excerpts (only the lines that settle a point), and for each test its file, the one command that runs it and its result.",
		`- Independent parts can go to separate workers at once (several calls in one step); \`id\` sends a follow-up to a worker that already reported (it keeps its context): to rerun, extend or settle something its evidence leaves open.`,
		"- Read a specific file or run a short command yourself only to settle a point the evidence leaves open; heavy reading and test runs go to the worker.",
		'- The verdict is yours alone: a worker\'s report is evidence, not a verdict; check that its tests test what you asked for. Tests the worker wrote and ran at your direction count as your own new tests; list them in "tests" with the commands exactly as they were run.',
		"</checker_pair>",
	].join("\n");
}

/** The earlier rounds' findings, for context; the round is still a full check. */
export function previousFindingsSection(findings: readonly string[]) {
	if (!findings.length) return "";
	return [
		"<previous_review>",
		"An earlier review of this deliverable reported these findings, and the builder has worked on them since. This is context, not a scope: this review is a full, independent check of all four parts from the start, and these points are checked among the rest, never instead of it.",
		...findings.map((finding) => `- ${finding}`),
		"</previous_review>",
	].join("\n");
}

/** What the worker sees: the runtime's frame around the judge's brief. */
export function checkerWorkerBrief(judgeBrief: string) {
	return [
		"You are the worker of an independent checker: its judge decides whether delivered work meets a user's request, and you do the reading, test writing and running it asks for. You are read-only: never change the deliverable or the checkout; write only under the scratch directory the brief names (copies, tests, inputs). Run what the brief asks exactly as it says (paths, invocation, a clean shell where it says so).",
		"Report compact evidence, not narration: each command exactly as run, its exit status and the output lines that matter; file:line excerpts holding only the lines that settle a point; for each test or probe you wrote, its file, the one command that runs it (absolute paths) and its result. Say plainly what you could not run and why. You give no verdict; the judge decides.",
		"",
		"<judge_brief>",
		judgeBrief.trim(),
		"</judge_brief>",
	].join("\n");
}

/** The longest brief the judge may write (the frame and SUBAGENT_BRIEF_MAX leave room for it). */
export const CHECKER_WORKER_BRIEF_MAX = 10_000;

/**
 * A worker's budget: the level's steps and tokens (half of what the judge
 * has left at most), and the judge's remaining minutes less the time it
 * needs to write its verdict. Unlike an ordinary child it may use most of
 * its parent's time: the judge waits for it. Null when too little is left.
 */
export function checkerWorkerBudget(input: {
	readonly level: number;
	readonly judgeRemaining: SubagentRemaining;
	/** The judge's wrap-up lead (checkerWrapUpLeadMs) in minutes. */
	readonly judgeWrapUpMinutes: number;
}): SubagentBudget | null {
	if (input.level < 1 || input.level > MAX_SUBAGENT_LEVEL) return null;
	const limits =
		SUBAGENT_LEVEL_LIMITS[input.level as keyof typeof SUBAGENT_LEVEL_LIMITS];
	const remaining = input.judgeRemaining;
	const half = (value: number) =>
		Number.isFinite(value) ? Math.floor(value / 2) : value;
	const minutes = Math.min(
		limits.minutes,
		Number.isFinite(remaining.minutes)
			? Math.floor((remaining.minutes - input.judgeWrapUpMinutes) * 10) / 10
			: limits.minutes,
	);
	const budget = {
		steps: limits.steps,
		minutes,
		tokens: Math.min(limits.tokens, half(remaining.tokens)),
	};
	return budget.minutes >= 1 && budget.tokens >= 50_000 ? budget : null;
}

/** Which session ran a listed test's command. */
export type TestRunner = NonNullable<CheckerTest["ranBy"]>;

/** The commands a session ran, as text to search: shell commands and tool inputs. */
export function ranCommandsText(items: readonly SessionItem[]) {
	return items
		.flatMap((item) =>
			item.kind === "commandExecution"
				? [item.command]
				: item.kind === "dynamicToolCall"
					? [item.input ?? ""]
					: [],
		)
		.join("\n");
}

const squash = (text: string) => text.replaceAll(/\s+/g, " ").trim();

/** The path-like words of a command (a test file, the copy), quotes stripped. */
function pathWords(command: string) {
	return command
		.split(/\s+/)
		.map((word) => word.replaceAll(/^["'`(]+|["'`);|&]+$/g, ""))
		.filter((word) => word.includes("/") && word.length >= 6);
}

/** Whether a test's command appears among what a session ran. */
export function testWasRun(test: CheckerTest, ran: string) {
	const command = test.command?.trim();
	if (!command || !ran) return false;
	if (squash(ran).includes(squash(command))) return true;
	const words = pathWords(command);
	return words.length > 0 && words.some((word) => ran.includes(word));
}

/**
 * The pair's verdict: the judge's JSON as parsed, each listed test marked
 * with who ran it (the worker, or the judge itself), and the untested-pass
 * rule applied to tests actually run: a pass none of whose listed tests
 * either session ran counts as unsure.
 */
export function pairReviewVerdict(
	verdict: ReviewVerdict,
	ran: { readonly worker: string; readonly judge: string },
): ReviewVerdict {
	const tests = verdict.tests.map((test) => {
		const ranBy: TestRunner | undefined = testWasRun(test, ran.worker)
			? "worker"
			: testWasRun(test, ran.judge)
				? "judge"
				: undefined;
		return ranBy ? { ...test, ranBy } : test;
	});
	const anyRun = tests.some((test) => test.ranBy);
	const untested =
		verdict.verdict === "pass" && !verdict.failures.length && !anyRun;
	return {
		...verdict,
		tests,
		...(untested
			? {
					verdict: "unsure",
					untested: true,
					notes: verdict.untested
						? verdict.notes
						: `${UNTESTED_PASS_NOTE}${verdict.notes ? ` ${verdict.notes}` : ""}`,
				}
			: {}),
	};
}
