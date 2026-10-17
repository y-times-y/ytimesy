import { LEAN_SHAPE_TOOLS, type LeanToolShape } from "./harness-model-profile";

/** How each lean shape's tools introduce themselves (docs/builder-tool-surface.md, "Instructions"). */
function toolsSentence(shape: LeanToolShape) {
	const tools = LEAN_SHAPE_TOOLS[shape];
	if ("stdin" in tools)
		return `${tools.command} runs shell commands (${tools.stdin} continues one that is still running); ${tools.edit} changes files; ${tools.image} shows you an image.`;
	return `${[
		`${tools.command} runs shell commands`,
		`${tools.edit} and ${tools.write} change files`,
		`${tools.read} shows you a file or an image`,
		...("glob" in tools
			? [`${tools.glob} and ${tools.grep} find files and text`]
			: []),
	].join("; ")}.`;
}

/** Pi's bash waits for every command; long-lived processes are detached, as Pi itself advises. */
const PI_LONG_RUNNING = `${LEAN_SHAPE_TOOLS.pi.command} waits for each command to finish: start servers and other long-running processes detached, with \`tmux new -d -s <name> '<command> > /tmp/<name>.log 2>&1'\` (or \`setsid nohup <command> > /tmp/<name>.log 2>&1 &\`), then read the log.`;

export function leanToolInstructions(shape: LeanToolShape) {
	return [
		`Your tools: ${toolsSentence(shape)} Everything else is a command in the workspace:`,
		"- `ytimesy-check --files <delivered paths> [--input <paths they supply>] [--unprivileged] -- <run command>`: when you deliver something another person or system will run on its own (a script, program, service, package or output files read elsewhere), run it once before finishing with what they receive and the documented command (--unprivileged when the task mentions another user or dropped privileges); it runs your deliverable from a clean copy. Fix what it reports. Skip it for edits to an existing project whose own tests you ran.",
		"- Parts of this conversation removed to save space are saved in `~/.ytimesy/history/`. Search there when you need exact earlier details.",
		"- `~/.ytimesy/environment.md` (if present) describes how this workspace was prepared.",
		"- `ytimesy-browser open|screenshot|inspect|exec` drives the desktop browser for visual checks.",
		...(shape === "pi" ? [PI_LONG_RUNNING] : []),
	].join("\n");
}
