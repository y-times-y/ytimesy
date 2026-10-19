import { LEAN_SHAPE_TOOLS, type LeanToolShape } from "./harness-model-profile";

/** "a, b and c". */
function listed(names: readonly string[]) {
	return names.length > 1
		? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
		: (names[0] ?? "");
}

/**
 * run_code's line when it is the main tool (codeMode=primary): named first,
 * with the tools its programs call, in the shape's names.
 */
function runCodeSentence(shape: LeanToolShape, readOnly: boolean) {
	const tools: {
		command: string;
		read?: string;
		edit: string;
		write?: string;
	} = LEAN_SHAPE_TOOLS[shape];
	const called = [
		tools.command,
		...(tools.read ? [tools.read] : []),
		...(readOnly ? [] : [tools.edit, ...(tools.write ? [tools.write] : [])]),
	];
	return `run_code runs programs that call ${listed([...new Set(called)])};`;
}

/** How each lean shape's tools introduce themselves (docs/builder-tool-surface.md, "Instructions"). */
function toolsSentence(shape: LeanToolShape, readOnly: boolean) {
	const tools = LEAN_SHAPE_TOOLS[shape];
	if ("stdin" in tools)
		return `${tools.command} runs shell commands (${tools.stdin} continues one that is still running);${readOnly ? "" : ` ${tools.edit} changes files;`} ${tools.image} shows you an image.`;
	return `${[
		`${tools.command} runs shell commands`,
		...(readOnly ? [] : [`${tools.edit} and ${tools.write} change files`]),
		`${tools.read} shows you a file or an image`,
		...("glob" in tools
			? [`${tools.glob} and ${tools.grep} find files and text`]
			: []),
	].join("; ")}.`;
}

/** A read-only subagent's commands run as the reader Linux user (src/domain/subagent-reader.ts). */
const READ_ONLY_COMMANDS =
	"Your commands run as a read-only user: you can read the checkout and run its programs and tests, but you cannot change the checkout or other agents' files. Write copies, scripts and scratch inputs only under $HOME or the scratch directory your brief names; when a command must write next to the code (build output, caches), copy the checkout there first and run it from the copy.";

/** The core bash tool waits for every command, so long-lived processes must be started detached. */
const DETACHED_LONG_RUNNING = `${LEAN_SHAPE_TOOLS.core.command} waits for each command to finish: start servers and other long-running processes detached, with \`tmux new -d -s <name> '<command> > /tmp/<name>.log 2>&1'\` (or \`setsid nohup <command> > /tmp/<name>.log 2>&1 &\`), then read the log.`;

export function leanToolInstructions(
	shape: LeanToolShape,
	options: {
		readOnly?: boolean;
		/** codeMode=primary: run_code is named first, as it is listed first. */
		codeMode?: boolean | "primary";
	} = {},
) {
	const runCode =
		options.codeMode === "primary"
			? `${runCodeSentence(shape, !!options.readOnly)} `
			: "";
	if (options.readOnly)
		return [
			`Your tools: ${runCode}${toolsSentence(shape, true)} ${READ_ONLY_COMMANDS}`,
			"- Parts of this conversation removed to save space are saved in `~/.ytimesy/history/`. Search there when you need exact earlier details.",
			"- `~/.ytimesy/environment.md` (if present) describes how this workspace was prepared.",
			...(shape === "core" ? [DETACHED_LONG_RUNNING] : []),
		].join("\n");
	return [
		`Your tools: ${runCode}${toolsSentence(shape, false)} Everything else is a command in the workspace:`,
		"- `ytimesy-check --files <delivered paths> [--input <paths they supply>] [--unprivileged] -- <run command>`: when you deliver something another person or system will run on its own (a script, program, service, package or output files read elsewhere), run it once before finishing with what they receive and the documented command (--unprivileged when the task mentions another user or dropped privileges); it runs your deliverable from a clean copy. Fix what it reports. Skip it for edits to an existing project whose own tests you ran.",
		"- Parts of this conversation removed to save space are saved in `~/.ytimesy/history/`. Search there when you need exact earlier details.",
		"- `~/.ytimesy/environment.md` (if present) describes how this workspace was prepared.",
		"- `ytimesy-browser open|screenshot|inspect|exec` drives the desktop browser for visual checks.",
		...(shape === "core" ? [DETACHED_LONG_RUNNING] : []),
	].join("\n");
}

/** When to use run_code (harness variant codeMode=on), in the shape's tool names. */
export function codeModeInstructions(shape: LeanToolShape) {
	const tools = LEAN_SHAPE_TOOLS[shape];
	const read = "read" in tools ? tools.read : tools.command;
	return `run_code runs one JavaScript program that calls your tools as async functions (tools.${read}, tools.${tools.command}, …) and gives you back only what it returns, in a single step. Use it when you already know several calls to make: reading or searching several files, looping over files or test cases, running independent checks together with Promise.all, or gathering output and filtering it down before you decide. Call tools directly for a single call, when each step depends on judging the previous result, and for interactive or long-running processes.`;
}

/**
 * run_code as the main tool (harness variant codeMode=primary): the
 * batching patterns, in the shape's tool names. Static per shape, so the
 * system prompt stays byte-stable.
 */
export function primaryCodeModeInstructions(
	shape: LeanToolShape,
	options: { readOnly?: boolean } = {},
) {
	const tools = LEAN_SHAPE_TOOLS[shape];
	const read = "read" in tools ? tools.read : tools.command;
	return [
		`run_code is your main tool: one JavaScript program calls your tools (tools.${read}, tools.${tools.command}${options.readOnly ? "" : `, tools.${tools.edit}`}, …) and returns only what you need, in one step.`,
		`Explore with one run_code program: list the tree and read the task's files with Promise.all.`,
		options.readOnly
			? "Run independent checks together in one program."
			: "Once you know the fix, make all planned edits and run the tests in ONE run_code program.",
		"Filter long output in code and return the relevant lines. Call a tool directly only for a single call, when the next call depends on judging this result, or for interactive or long-running processes.",
	].join(" ");
}
