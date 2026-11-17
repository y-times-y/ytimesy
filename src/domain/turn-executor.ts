import { isDevelopmentEnvironment } from "./development-environment";

export type TurnExecutor = "node" | "durable-object";

export function configuredTurnExecutor(
	value: string | undefined,
): TurnExecutor {
	if (value === undefined || value === "node") return "node";
	if (value === "durable-object") return value;
	throw new Error("Invalid model turn executor selection.");
}

/** The users whose API turns may run on the turn runner boxes (comma separated ids; "*" is everyone). */
export function boxTurnUsers(value: string | undefined): ReadonlySet<string> {
	return new Set(
		(value ?? "")
			.split(",")
			.map((id) => id.trim())
			.filter(Boolean),
	);
}

/**
 * Where a new turn runs. The boxes take it only when the deployment runs
 * turns in Durable Objects, the user is enabled for boxes, the turn is an API
 * connection's (not a Codex or Claude subscription's), and a box was seen
 * lately: with none, the turn runs in its chat's object as before, so a
 * down fleet never strands a turn.
 */
export function chooseTurnExecutor(input: {
	readonly configured: TurnExecutor;
	readonly userId: string;
	readonly boxUsers: ReadonlySet<string>;
	readonly eligible: boolean;
	readonly boxAlive: boolean;
}): TurnExecutor {
	if (input.configured !== "durable-object") return input.configured;
	const enabled = input.boxUsers.has("*") || input.boxUsers.has(input.userId);
	return enabled && input.eligible && input.boxAlive
		? "node"
		: input.configured;
}

/**
 * What keeps one turn off the boxes even though its user is enabled
 * (docs/turn-runner-boxes.md, "Routing"). Decided when the turn is queued,
 * from facts read about its chat; null means the box may run it.
 *
 * - `subagent`: a helper chat (reader, writer, checker, Y-squared worker)
 *   shares its parent's machine and reports through the parent: the box's
 *   workspace port and the edge's post-settle work serve root chats only.
 * - `evaluation`: harness evaluation runs stay in Durable Objects.
 * - `runtime-secrets`: the project (or the user's account) holds a
 *   runtime-kind secret. `vm/ensure` answers 403 `secrets` for those unless
 *   YTIMESY_CLAUDE_BOX_TOOLS_SECRETS=1 (then the VM redacts its own output).
 */
export type BoxTurnBlock = "subagent" | "evaluation" | "runtime-secrets";

export function boxTurnBlock(
	facts: {
		readonly subagent: boolean;
		readonly evaluation: boolean;
		readonly hasRuntimeSecrets: boolean;
	},
	env: { readonly YTIMESY_CLAUDE_BOX_TOOLS_SECRETS?: string } = process.env,
): BoxTurnBlock | null {
	if (facts.subagent) return "subagent";
	if (facts.evaluation) return "evaluation";
	if (facts.hasRuntimeSecrets && env.YTIMESY_CLAUDE_BOX_TOOLS_SECRETS !== "1")
		return "runtime-secrets";
	return null;
}

/**
 * Development only (`YTIMESY_LOCAL_TURNS=1` on a development server, never a
 * production build): a Y² turn, which needs no machine, runs in this Node
 * process instead of on the deployed edge, so new turn code can be tried on
 * localhost without deploying (src/server/jobs/local-turn.ts).
 */
export function localTurnsEnabled(
	env: {
		readonly YTIMESY_LOCAL_TURNS?: string;
		readonly YTIMESY_ENVIRONMENT?: string;
		readonly NODE_ENV?: string;
	} = process.env,
): boolean {
	return (
		env.YTIMESY_LOCAL_TURNS === "1" &&
		isDevelopmentEnvironment(env) &&
		env.NODE_ENV !== "production"
	);
}
