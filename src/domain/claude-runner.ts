/**
 * Claude Code on a runner box (docs/claude-code-placement.md): the `claude`
 * process runs on a small AWS box that holds no repository, and everything it
 * does to the chat's code goes through ytimesy's own tools (served over MCP)
 * to the chat's Freestyle machine. The chat machine is then only a workspace:
 * losing it costs a tool call, not the turn.
 *
 * Off unless YTIMESY_CLAUDE_RUNNER_URLS and YTIMESY_CLAUDE_RUNNER_SECRET are
 * set; YTIMESY_CLAUDE_RUNNER_USERS limits it to listed user ids ("*": everyone).
 */
export type ClaudeRunnerBox = {
	readonly baseUrl: string;
	readonly secret: string;
};

/** The runner box's working directory for `claude` (it has no repository). */
export const CLAUDE_RUNNER_WORKDIR = "/var/lib/ytimesy-runner/work";

/**
 * Claude Code's own file, shell and subagent tools, off on a runner box: they
 * would act on the box. ytimesy's tools of the same jobs take their place.
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
	"AskUserQuestion",
] as const;

function turnHash(turnId: string) {
	let hash = 2166136261;
	for (const char of turnId) {
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
 * as before). The same turn always gets the same box, so each step finds the
 * process it started. Read-only helpers stay on the chat machine.
 */
export function claudeRunnerFor(input: {
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly userId: string;
	readonly turnId: string;
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
	return { baseUrl: urls[turnHash(input.turnId) % urls.length], secret };
}

/** What the system prompt says of working through tools when the code is not on this machine. */
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
		"Keep using your own TodoWrite to plan multi-step work; the chat shows it.",
	];
}
