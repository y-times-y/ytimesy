import type { ReviewVerdict } from "./checker-brief";
import { NO_VERDICT_FAILURE } from "./checker-verdict";
import { CODE_MODE_TOOL, codeModeResult } from "./code-mode";
import { leanToolNames } from "./harness-model-profile";
import type { SessionItem } from "./session-item";

/**
 * Execution-grounded verdicts (user decision 2026-10-22: "it has to literally
 * run and make sure it is accurate"). On TB4 the checker, reasoning over
 * text, endorsed the builder's wrong readings; it caught real bugs only when
 * it ran reproductions. So the review loop matches every command a finding
 * or a requirement cites against the commands the checker actually ran:
 * a finding no executed command shows is set aside as a note (it cannot fail
 * the work), and a pass that no executed command verified is no verdict.
 */

/** Tools that execute something: the lean shapes' command tools and run_code. */
const COMMAND_TOOLS = new Set<string>([
	...leanToolNames(["command"]),
	"bash",
	"shell",
	"exec",
	CODE_MODE_TOOL,
]);

/** The command in a tool call's input (JSON with command/cmd/code, else the text). */
function commandText(input: string) {
	try {
		const parsed = JSON.parse(input) as Record<string, unknown>;
		const command = parsed?.command ?? parsed?.cmd ?? parsed?.code;
		return typeof command === "string" ? command : input;
	} catch {
		return input;
	}
}

/**
 * The commands a session executed: shell commands, command-tool calls and
 * run_code programs with their inner command calls. File writes and reads
 * are not executions (a script written but never run shows nothing).
 */
export function executedCommands(items: readonly SessionItem[]): string[] {
	const commands: string[] = [];
	for (const item of items) {
		if (item.kind === "commandExecution") commands.push(item.command);
		if (item.kind !== "dynamicToolCall" || !COMMAND_TOOLS.has(item.tool))
			continue;
		if (item.input) commands.push(commandText(item.input));
		if (item.tool === CODE_MODE_TOOL)
			for (const call of codeModeResult(item)?.calls ?? [])
				if (
					call &&
					typeof call.tool === "string" &&
					COMMAND_TOOLS.has(call.tool) &&
					typeof call.input === "string"
				)
					commands.push(commandText(call.input));
	}
	return commands.filter((command) => command.trim());
}

const squash = (text: string) => text.replaceAll(/\s+/g, " ").trim();

/** The path-like words of a command, quotes stripped. */
const pathWords = (command: string) =>
	command
		.split(/\s+/)
		.map((word) => word.replaceAll(/^["'`(]+|["'`);|&]+$/g, ""))
		.filter((word) => word.includes("/") && word.length >= 6);

/**
 * Whether a cited command is among those run, tolerantly: whitespace
 * ignored; the cited text may be part of a run command; each `&&`/`;` step
 * may have run on its own; or the same program ran with every path it names.
 */
export function commandWasRun(cited: string, executed: readonly string[]) {
	const command = squash(cited.replace(/^\s*\$\s+/, ""));
	if (!command) return false;
	const runs = executed.map(squash);
	if (runs.some((run) => run.includes(command))) return true;
	const steps = command
		.split(/\s*(?:&&|;)\s*/)
		.map((step) => step.trim())
		.filter(Boolean);
	if (
		steps.length > 1 &&
		steps.every((step) => runs.some((run) => run.includes(step)))
	)
		return true;
	const program = command.split(" ")[0] ?? "";
	const paths = pathWords(command);
	return (
		paths.length > 0 &&
		runs.some(
			(run) =>
				run.includes(program) && paths.every((path) => run.includes(path)),
		)
	);
}

/** The `code spans` of a text: commands a string-only finding cites inline. */
const inlineCommands = (text: string) =>
	[...text.matchAll(/`([^`\n]{3,})`/g)].map((match) => match[1]);

/** A finding about a test: its name leads it, or a long name appears in it. */
const namesTest = (text: string, name: string) =>
	text === name ||
	text.startsWith(`${name}:`) ||
	(name.length >= 12 && text.includes(name));

/** The note set-aside findings get. */
const SET_ASIDE_NOTE = "(Set aside: no command the checker ran shows these.)";

/** The note a pass no executed command verified gets. */
export const UNGROUNDED_PASS_NOTE =
	"(No command it ran verified the stated requirements; counted as no verdict.)";

/**
 * The verdict with the evidence checked against what the checker executed
 * (`executed` null: its log was unavailable, the verdict stands as parsed):
 * - its tests whose command it never ran are marked unrun (never handed over),
 * - a failure, or an unmet requirement, that cites no executed command (nor
 *   names a failing test it ran) becomes a note and is counted in downgraded,
 * - a fail left without findings is a pass when a test of its own ran (else
 *   unsure), and a pass (or such a fail) that nothing it ran verified is
 *   ungrounded: unsure, retried like no verdict.
 */
export function groundReviewVerdict(
	verdict: ReviewVerdict,
	executed: readonly string[] | null,
): ReviewVerdict {
	if (!executed || !verdict.parsed) return verdict;
	const ran = (commands: readonly (string | undefined)[]) =>
		commands.some((command) => !!command && commandWasRun(command, executed));
	const tests = verdict.tests.map((test) =>
		ran([test.command]) ? test : { ...test, unrun: true as const },
	);
	const failingRun = tests.filter((test) => !test.passed && !test.unrun);
	const downgraded: string[] = [];
	const failures: string[] = [];
	const failureEvidence: { command: string; output: string }[] = [];
	verdict.failures.forEach((text, index) => {
		const evidence = verdict.failureEvidence?.[index] ?? {
			command: "",
			output: "",
		};
		const shown =
			text === NO_VERDICT_FAILURE ||
			failingRun.some((test) => namesTest(text, test.name)) ||
			ran([evidence.command, ...inlineCommands(text)]);
		if (shown) {
			failures.push(text);
			failureEvidence.push(evidence);
		} else downgraded.push(text);
	});
	// Listed findings all set aside: the failing tests it did run still stand.
	if (!failures.length)
		for (const test of failingRun.filter((test) => !test.probe)) {
			const output = test.evidence ?? test.output ?? "";
			failures.push(output ? `${test.name}: ${output}` : test.name);
			failureEvidence.push({ command: test.command ?? "", output });
		}
	const requirements = verdict.requirements.map((entry) => {
		const shown = ran([entry.command, ...inlineCommands(entry.evidence)]);
		if (entry.met !== false || shown) return { entry, shown };
		const text = entry.evidence
			? `${entry.requirement}: ${entry.evidence}`
			: entry.requirement;
		if (!downgraded.some((line) => line.startsWith(entry.requirement)))
			downgraded.push(text);
		return { entry: { ...entry, met: null }, shown };
	});
	const unmetShown = requirements.some(
		({ entry, shown }) => entry.met === false && shown,
	);
	const testsRun = tests.some((test) => !test.probe && !test.unrun);
	const verified =
		testsRun ||
		requirements.some(({ entry, shown }) => entry.met === true && shown);
	const claimedPass = verdict.verdict === "pass" || !!verdict.untested;
	const emptied = verdict.verdict === "fail" && !failures.length && !unmetShown;
	const ungrounded = (claimedPass || emptied) && !verified;
	const kind = ungrounded
		? "unsure"
		: emptied
			? testsRun
				? "pass"
				: "unsure"
			: verdict.verdict;
	const notes = [
		ungrounded ? UNGROUNDED_PASS_NOTE : "",
		downgraded.length
			? `${SET_ASIDE_NOTE} ${downgraded.map((line) => line.slice(0, 300)).join("; ")}`
			: "",
		verdict.notes,
	]
		.filter(Boolean)
		.join(" ");
	return {
		...verdict,
		verdict: kind,
		failures,
		failureEvidence,
		tests,
		requirements: requirements.map(({ entry }) => entry),
		notes,
		downgraded,
		...(ungrounded ? { ungrounded: true as const } : {}),
	};
}
