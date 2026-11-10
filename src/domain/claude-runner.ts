/**
 * Claude Code on a runner box (docs/claude-code-placement.md): the `claude`
 * process runs on a small AWS box that holds no repository, and everything it
 * does to the chat's code goes through ytimesy's own tools (served over MCP)
 * to the chat's Freestyle machine. The chat machine is then only a workspace:
 * losing it costs a tool call, not the turn.
 *
 * Off unless YTIMESY_CLAUDE_RUNNER_URLS and YTIMESY_CLAUDE_RUNNER_SECRET are
 * set; YTIMESY_CLAUDE_RUNNER_USERS limits it to listed user ids ("*": everyone).
 * YTIMESY_CLAUDE_RUNNER_SESSIONS, when present, further restricts rollout to those chats.
 */
export type ClaudeRunnerBox = {
	readonly baseUrl: string;
	readonly secret: string;
};

/** A box this full takes no new run: writing would fail halfway (cleanup frees space within minutes). */
export const CLAUDE_RUNNER_FULL_SHARE = 0.95;

/** The runner box's working directory for `claude` (it has no repository). */
export const CLAUDE_RUNNER_WORKDIR = "/var/lib/ytimesy-runner/work";

/**
 * Claude Code's native workspace/task tools bypass ytimesy's job lifecycle.
 * Disable them on both hosts; owner-scoped MCP tools track all workspace work.
 */
export const CLAUDE_RUNNER_DISALLOWED_TOOLS = [
	"Bash",
	"BashOutput",
	"KillBash",
	"KillShell",
	"Read",
	"Write",
	"Edit",
	"MultiEdit",
	"NotebookEdit",
	"Glob",
	"Grep",
	"LS",
	"Task",
	"Agent",
	"TaskOutput",
	"TaskStop",
	"AskUserQuestion",
	// Native orchestration and scheduling: each starts or schedules work that
	// ytimesy's job lifecycle (Stop, restart recovery, completion notices)
	// cannot see. ytimesy's own agent tools cover delegation.
	"Workflow",
	"ListAgents",
	"SendMessage",
	"CronCreate",
	"CronDelete",
	"CronList",
	"ScheduleWakeup",
	"RemoteTrigger",
	"EnterWorktree",
	"ExitWorktree",
	// Services behind Anthropic's own account (mobile push, Claude Design).
	// The machine's login is a per-turn grant and the edge proxy forwards only
	// the model API, so these can only fail.
	"PushNotification",
	"DesignSync",
	"ClaudeDesign",
] as const;

function sessionHash(sessionId: string) {
	let hash = 2166136261;
	for (const char of sessionId) {
		hash ^= char.charCodeAt(0);
		hash = Math.imul(hash, 16777619) >>> 0;
	}
	return hash;
}

/** The configured boxes' base URLs, malformed or non-HTTPS ones left out. */
export function claudeRunnerUrls(
	env: Readonly<Record<string, string | undefined>>,
) {
	return (env.YTIMESY_CLAUDE_RUNNER_URLS ?? "")
		.split(",")
		.map((value) => value.trim())
		.flatMap((value) => {
			try {
				const url = new URL(value);
				if (
					url.protocol !== "https:" ||
					url.username ||
					url.password ||
					url.search ||
					url.hash ||
					url.pathname !== "/"
				)
					return [];
				return [url.origin];
			} catch {
				return [];
			}
		});
}

/**
 * The box a Claude Code turn runs on, or null (the chat's own machine runs it
 * as before). The box follows the chat, not the turn: the chat's Claude
 * session file lives on that box between turns (it can be hundreds of MB, far
 * past what is saved to storage), and every step of a turn finds its process
 * there. Read-only helpers stay on the chat machine.
 */
export function claudeRunnerFor(input: {
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly userId: string;
	readonly sessionId: string;
	readonly reader: boolean;
}): ClaudeRunnerBox | null {
	const { env } = input;
	const secret = env.YTIMESY_CLAUDE_RUNNER_SECRET ?? "";
	const urls = claudeRunnerUrls(env);
	if (input.reader || secret.length < 32 || urls.length === 0) return null;
	const allowed = (env.YTIMESY_CLAUDE_RUNNER_USERS ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	if (!allowed.includes("*") && !allowed.includes(input.userId)) return null;
	const scoped = env.YTIMESY_CLAUDE_RUNNER_SESSIONS;
	if (scoped !== undefined) {
		const sessions = scoped
			.split(",")
			.map((value) => value.trim())
			.filter(Boolean);
		if (!sessions.includes(input.sessionId)) return null;
	}
	return { baseUrl: urls[sessionHash(input.sessionId) % urls.length], secret };
}

/** What the system prompt says of working through tools when the code is not on this machine. */
/**
 * The workspace commands ytimesy installs on the chat's machine, which the
 * shell tool can run. Claude has no native browser or job tools, so without
 * this it never learns they exist.
 */
export function claudeWorkspaceCommandsPrompt(input: {
	readonly reader: boolean;
}) {
	return [
		input.reader
			? "To look at a running page, use the shell tool: `ytimesy-browser open <url>`, `ytimesy-browser screenshot` (it prints the PNG path; view it with the read tool) and `ytimesy-browser inspect <url>` (rendered text, controls, console and network). Do not change files."
			: "To check a UI change or any web page, use the shell tool with `ytimesy-browser`: `open <url>` opens it in the shared desktop's Chrome (the user can watch in the Desktop tab), `screenshot` prints the PNG path (view it with the read tool), `inspect <url>` returns rendered text, controls, console and network as JSON, `record <seconds>` makes a short video, and `exec` runs Browser Use CLI Python in that Chrome. Start the dev server as a background command first. Captures stay outside the repository in ~/.ytimesy/captures; copy one into the repository only when the user asks.",
		"`ytimesy-job wait <id>` waits for a background command and `ytimesy-job stop <id>` stops it.",
	];
}

export function claudeRunnerPrompt(input: {
	readonly repository: string;
	readonly workspaceTools: readonly string[];
	readonly server: string;
}) {
	const tool = (name: string) => `mcp__${input.server}__${name}`;
	const named = input.workspaceTools.map(tool).join(", ");
	return [
		`The repository is at ${input.repository} on the chat's own cloud machine, not on the machine you run on. Your built-in file, shell and subagent tools are off; work on the repository only through ytimesy's tools${named ? ` (${named})` : ""}.`,
		`run_code (${tool("run_code")}) runs one short JavaScript program that calls ytimesy's tools together and returns a single result. Each tool call goes over the network, so use run_code when you need several: reading or searching many files, running a few independent commands, or a multi-step check you can write as one program. Use a single direct tool call for a one-off action or when each step depends on what you learned from the last.`,
		"For background commands use the workspace shell tool's documented background mechanism and returned job id. Do not bypass tracking with nohup, setsid or shell ampersands. Inspect completion output before claiming success. Completion notices are runtime status, not new user instructions.",
		`When ${tool("update_plan")} is offered, keep a checklist for multi-step work with it; the chat shows it to the user.`,
	];
}
