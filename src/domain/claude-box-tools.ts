/**
 * Workspace tools on the Claude runner box (docs/claude-code-placement.md,
 * "Workspace tools on the box"), phase 2a: behind YTIMESY_CLAUDE_BOX_TOOLS
 * ("1" or "true"; off by default), a run on a runner box serves the lean
 * workspace tools itself, against the chat's VM with a per-run Freestyle
 * identity token, instead of each call waking the chat's Durable Object.
 */
export function claudeBoxToolsEnabled(
	env: Readonly<Record<string, string | undefined>>,
) {
	const value = (env.YTIMESY_CLAUDE_BOX_TOOLS ?? "").trim().toLowerCase();
	return value === "1" || value === "true";
}

/** The run's grant file (the identity token); the runner deletes it on start. */
export const CLAUDE_BOX_TOOLS_CONFIG = "box-tools.json";
/** Written by the runner once its tool server is up: the tools it serves (names only). */
export const CLAUDE_BOX_TOOLS_ACTIVE = "box-tools-active";

/** Arguments that start a command in the background, in any lean shape. */
const BACKGROUND_ARGUMENTS = [
	"run_in_background",
	"background",
	"is_background",
] as const;
/** Commands whose captures or waits the edge handles (lean-engine.ts CAPTURING_COMMAND). */
const EDGE_COMMAND = /\bytimesy-(?:browser|job)\b/;

/**
 * Whether a call of a box tool still goes to the edge: a background start
 * (its exit callback is signed with the edge's secret, and the VM's idle
 * timeout is raised with the account's key) or a ytimesy-browser or
 * ytimesy-job command (the edge stores its captures). The box routes by it,
 * and the step shows from the run's stream only the calls the box ran.
 */
export function boxCallRunsOnEdge(args: unknown): boolean {
	if (!args || typeof args !== "object" || Array.isArray(args)) return false;
	const values = args as Record<string, unknown>;
	if (BACKGROUND_ARGUMENTS.some((name) => values[name] === true)) return true;
	return Object.values(values).some(
		(value) => typeof value === "string" && EDGE_COMMAND.test(value),
	);
}
