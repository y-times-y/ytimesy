import type { ToolSet } from "ai";
import { CANVAS_TOOL } from "#/domain/canvas";
import {
	LEAN_COMMAND_ARGUMENTS,
	leanToolRole,
} from "#/domain/harness-model-profile";
import { AGENT_SEND_TOOL, AGENT_TOOL } from "#/domain/subagent";
import { withOutputCap } from "./tool-output-cap";

/**
 * The thin fusion lead's tools (harness variant lead=fusion with
 * leadTools=thin, product and Harbor bridge alike): it plans, briefs and
 * reviews; its writer explores, implements and runs the checks. From the
 * builder's surface it keeps only
 *
 * - agent and agent_send (its writer; readers and the checker in the product),
 * - the surface's read tool, its output capped,
 * - the surface's command tool as a bounded read-only inspection: one
 *   allowlisted program per pipeline stage (git status/diff/log/show, ls,
 *   head, wc, grep and the like), no redirection, substitution or
 *   background jobs, its output capped,
 * - the few conversational tools (ask_user, report_task_blocked,
 *   request_project_secret) and the display-only canvas.
 *
 * Everything else is dropped: edit, write, apply_patch, stdin to a running
 * command, run_code, MCP, browser and web search. Model-facing text names
 * the writer, never the sidekick.
 */

/** The most characters one inspection or read shows the lead. */
export const THIN_LEAD_OUTPUT_CHARS = 8_000;

/** Tools the thin lead keeps by name (the lean read and command tools are kept by role). */
const KEPT = new Set<string>([
	AGENT_TOOL,
	AGENT_SEND_TOOL,
	"ask_user",
	"report_task_blocked",
	"request_project_secret",
	CANVAS_TOOL,
]);

/** Read-only programs one pipeline stage may run. */
const PROGRAMS = new Set([
	"cat",
	"cd",
	"cut",
	"diff",
	"du",
	"file",
	"find",
	"git",
	"grep",
	"head",
	"ls",
	"nl",
	"pwd",
	"rg",
	"sed",
	"sort",
	"stat",
	"tail",
	"tree",
	"uniq",
	"wc",
]);
const GIT_READS = new Set([
	"blame",
	"diff",
	"log",
	"ls-files",
	"rev-parse",
	"show",
	"status",
]);
/** Per program, arguments that would write, execute or reconfigure. */
const UNSAFE_ARGUMENTS: Readonly<Record<string, RegExp>> = {
	sed: /^(?:-i\S*|--in-place\S*|-[a-z]*i[a-z]*)$/,
	git: /^(?:--output\S*|--ext-diff|-c|--exec-path\S*)$/,
	find: /^(?:-exec\S*|-ok\S*|-delete|-fprint\S*|-fls)$/,
	sort: /^(?:-o\S*|--output\S*)$/,
	rg: /^(?:--pre\S*)$/,
};

/** Splits a command into pipeline stages of words, or a reason it is refused. */
function stages(command: string): string[][] | string {
	const result: string[][] = [[]];
	let word = "";
	let quote: "'" | '"' | null = null;
	let quoted = false;
	const push = () => {
		if (word || quoted) result.at(-1)?.push(word);
		word = "";
		quoted = false;
	};
	for (let index = 0; index < command.length; index++) {
		const char = command[index] as string;
		const next = command[index + 1];
		if (quote) {
			if (char === quote) quote = null;
			else if (
				quote === '"' &&
				(char === "`" || (char === "$" && next === "("))
			)
				return "command substitution is not available";
			else word += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			quoted = true;
			continue;
		}
		if (char === "`" || (char === "$" && next === "("))
			return "command substitution is not available";
		if (char === ">" || char === "<")
			return "redirection is not available (it could write files)";
		if (char === ";" || char === "\n")
			return "use && or | between commands, one inspection per call";
		if (char === "&" && next !== "&")
			return "background jobs are not available";
		if ((char === "&" || char === "|") && next === char) {
			push();
			result.push([]);
			index++;
			continue;
		}
		if (char === "|") {
			push();
			result.push([]);
			continue;
		}
		if (/\s/.test(char)) {
			push();
			continue;
		}
		word += char;
	}
	if (quote) return "unbalanced quotes";
	push();
	return result;
}

/**
 * Null when `command` is a read-only inspection the thin lead may run,
 * else why not (the refusal names what to do instead).
 */
export function leadInspectionRefusal(command: string): string | null {
	const parsed = stages(command.trim());
	if (typeof parsed === "string") return parsed;
	for (const words of parsed) {
		const [program, ...rest] = words;
		if (!program) return "an empty command stage";
		if (/^\w+=/.test(program))
			return "environment assignments are not available";
		if (!PROGRAMS.has(program))
			return `\`${program}\` is not an inspection command`;
		const pattern = UNSAFE_ARGUMENTS[program];
		const unsafe = pattern && rest.find((argument) => pattern.test(argument));
		if (unsafe) return `\`${program} ${unsafe}\` could change files`;
		if (program === "git") {
			let index = 0;
			while (rest[index] === "-C" || rest[index] === "--no-pager")
				index += rest[index] === "-C" ? 2 : 1;
			const sub = rest[index];
			if (!sub || !GIT_READS.has(sub))
				return `\`git ${sub ?? ""}\` is not an inspection (allowed: ${[...GIT_READS].join(", ")})`;
		}
		if (program === "sed" && !rest.includes("-n"))
			return "use `sed -n '<from>,<to>p' <file>` to show lines";
	}
	return null;
}

const INSPECTION_NOTE = `Read-only inspection for reviewing your writer's work: git status, git diff (--stat first), git log, git show, ls, head, tail, sed -n, wc, grep, find and the like, joined with | or &&. Nothing that writes, builds, installs or runs tests or programs: your writer does that. Output past ${THIN_LEAD_OUTPUT_CHARS.toLocaleString("en-US")} characters is cut in the middle.`;

/** The command tool limited to read-only inspections. */
function inspection(
	name: string,
	definition: ToolSet[string],
): ToolSet[string] {
	const execute = definition.execute;
	if (!execute) return definition;
	const argument = LEAN_COMMAND_ARGUMENTS[name] ?? "command";
	return {
		...(definition as object),
		description: INSPECTION_NOTE,
		execute: (...args: Parameters<typeof execute>) => {
			const input = (args[0] ?? {}) as Record<string, unknown>;
			const command = String(input[argument] ?? "");
			const refused = input.background
				? "background commands are not available"
				: leadInspectionRefusal(command);
			if (refused)
				throw new Error(
					`Refused: ${refused}. You inspect; your writer builds, edits and runs checks. Send it a brief with ${AGENT_SEND_TOOL} (or start it with ${AGENT_TOOL}).`,
				);
			return execute(...args);
		},
	} as ToolSet[string];
}

/** The thin lead's tool set from the builder's tools (lean surface plus delegation). */
export function thinLeadTools(tools: ToolSet): ToolSet {
	const own: ToolSet = {};
	const agents: ToolSet = {};
	for (const [name, definition] of Object.entries(tools)) {
		const role = leanToolRole(name);
		if (role === "command") own[name] = inspection(name, definition);
		else if (role === "read") own[name] = definition;
		else if (name === AGENT_TOOL || name === AGENT_SEND_TOOL)
			agents[name] = definition;
		else if (KEPT.has(name)) own[name] = definition;
	}
	return { ...withOutputCap(own, THIN_LEAD_OUTPUT_CHARS), ...agents };
}
