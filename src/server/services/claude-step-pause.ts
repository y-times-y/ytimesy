/**
 * Lets a Claude Code turn's chat object sleep while Claude works on its own.
 *
 * A step that has nothing to answer (no ytimesy tool call running or queued)
 * and nobody watching the chat live ends early and asks for a pause; the
 * executor schedules the next step after it instead of at once. Any MCP
 * request from the run that arrives while no step runs wakes the turn at
 * once (the executor's MCP route), so a tool call never waits for the pause.
 * Keyed by turn: chat objects can share an isolate.
 */

/** How long a quiet, unwatched turn sleeps between looks at its run. */
export const CLAUDE_STEP_PAUSE_MS = 15_000;
/** A step runs at least this long before it may pause (a wake is not free). */
export const CLAUDE_STEP_MIN_AWAKE_MS = 4_000;

type TurnHooks = {
	/** Someone has the chat open live (a socket or an event stream). */
	readonly watched: () => boolean;
};

const hooks = new Map<string, TurnHooks>();
const pauses = new Map<string, number>();

/** The executor registers the turn's hooks while it drives the turn. */
export function registerClaudeTurn(turnId: string, turn: TurnHooks) {
	hooks.set(turnId, turn);
	return () => {
		if (hooks.get(turnId) === turn) hooks.delete(turnId);
	};
}

/** Whether this turn may sleep between steps: registered and unwatched. */
export function claudeTurnMayPause(turnId: string) {
	// Off switch for the edge executor's environment.
	if (process.env.YTIMESY_CLAUDE_STEP_PAUSE === "0") return false;
	const turn = hooks.get(turnId);
	if (!turn) return false;
	try {
		return !turn.watched();
	} catch {
		return false;
	}
}

/** The step ends early; its next one should start after `ms`. */
export function requestClaudeStepPause(turnId: string, ms: number) {
	pauses.set(turnId, ms);
}

/** The pause the step that just ended asked for (taken once), else 0. */
export function takeClaudeStepPause(turnId: string) {
	const ms = pauses.get(turnId) ?? 0;
	pauses.delete(turnId);
	return ms;
}
