import type { LeanToolShape } from "./harness-model-profile";

/** How each lean shape's tools introduce themselves (docs/builder-tool-surface.md, "Instructions"). */
const TOOLS: Readonly<Record<LeanToolShape, string>> = {
	codex:
		"exec_command runs shell commands (write_stdin continues one that is still running); apply_patch changes files; view_image shows you an image.",
	claude:
		"Bash runs shell commands; Edit and Write change files; Read shows you a file or an image; Glob and Grep find files and text.",
	gemini:
		"run_shell_command runs shell commands; replace and write_file change files; read_file shows you a file or an image; glob and grep_search find files and text.",
	qwen: "run_shell_command runs shell commands; edit and write_file change files; read_file shows you a file or an image; glob and grep_search find files and text.",
	pi: "bash runs shell commands; edit and write change files; read shows you a file or an image.",
};

/** Pi's bash waits for every command; long-lived processes are detached, as Pi itself advises. */
const PI_LONG_RUNNING =
	"bash waits for each command to finish: start servers and other long-running processes detached, with `tmux new -d -s <name> '<command> > /tmp/<name>.log 2>&1'` (or `setsid nohup <command> > /tmp/<name>.log 2>&1 &`), then read the log.";

export function leanToolInstructions(shape: LeanToolShape) {
	return [
		`Your tools: ${TOOLS[shape]} Everything else is a command in the workspace:`,
		"- `ytimesy-check --files <delivered paths> [--input <paths they supply>] [--unprivileged] -- <run command>`: when you deliver something another person or system will run on its own (a script, program, service, package or output files read elsewhere), run it once before finishing with what they receive and the documented command (--unprivileged when the task mentions another user or dropped privileges); it runs your deliverable from a clean copy. Fix what it reports. Skip it for edits to an existing project whose own tests you ran.",
		"- Parts of this conversation removed to save space are saved in `~/.ytimesy/history/`. Search there when you need exact earlier details.",
		"- `~/.ytimesy/environment.md` (if present) describes how this workspace was prepared.",
		"- `ytimesy-browser open|screenshot|inspect|exec` drives the desktop browser for visual checks.",
		...(shape === "pi" ? [PI_LONG_RUNNING] : []),
	].join("\n");
}
