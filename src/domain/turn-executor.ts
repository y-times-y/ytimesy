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
 * - `subagent`: a child chat without a role (a side chat); helpers with a
 *   role run on boxes.
 * - `evaluation`: harness evaluation runs stay in Durable Objects.
 * - `runtime-secrets`: the project (or the user's account) holds a
 *   runtime-kind secret. `vm/ensure` answers 403 `secrets` for those unless
 *   YTIMESY_TURN_BOX_SECRETS=1 (or the Claude runner's
 *   YTIMESY_CLAUDE_BOX_TOOLS_SECRETS=1); then the VM redacts its own output.
 * - `lead-fusion`: harness variant lead=fusion; its sidekick's round, state
 *   and retirement are not served to a box.
 *
 * A project's Y² chat and helpers with a role run on boxes (their tools and
 * reports go through the edge: turn-box-y-squared-port.ts,
 * turn-box-helper-port.ts).
 */
export type BoxTurnBlock =
	| "subagent"
	| "evaluation"
	| "runtime-secrets"
	| "lead-fusion";

/** Whether turn boxes may run chats whose project or account holds runtime secrets. */
export function turnBoxSecretsAllowed(env: {
	readonly YTIMESY_TURN_BOX_SECRETS?: string;
	readonly YTIMESY_CLAUDE_BOX_TOOLS_SECRETS?: string;
}) {
	return (
		env.YTIMESY_TURN_BOX_SECRETS === "1" ||
		env.YTIMESY_CLAUDE_BOX_TOOLS_SECRETS === "1"
	);
}

export function boxTurnBlock(
	facts: {
		readonly subagent: boolean;
		readonly evaluation: boolean;
		readonly hasRuntimeSecrets: boolean;
		readonly ySquared?: boolean;
		/** Harness variant lead=fusion (its sidekick work is not served to a box). */
		readonly leadFusion?: boolean;
	},
	env: {
		readonly YTIMESY_TURN_BOX_SECRETS?: string;
		readonly YTIMESY_CLAUDE_BOX_TOOLS_SECRETS?: string;
	} = process.env,
): BoxTurnBlock | null {
	if (facts.subagent) return "subagent";
	if (facts.evaluation) return "evaluation";
	if (facts.leadFusion) return "lead-fusion";
	if (facts.hasRuntimeSecrets && !turnBoxSecretsAllowed(env))
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
