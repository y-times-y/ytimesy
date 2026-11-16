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

import type { ClaudeStepPause } from "#/domain/claude-parked-turn";
import type { ClaudeCodeFeed } from "./claude-code-runner";

/** How long a quiet, unwatched turn sleeps between looks at its run. */
export const CLAUDE_STEP_PAUSE_MS = 15_000;
/** A step runs at least this long before it may pause (a wake is not free). */
export const CLAUDE_STEP_MIN_AWAKE_MS = 4_000;

type TurnHooks = {
	/** Someone has the chat open live (a socket or an event stream). */
	readonly watched: () => boolean;
	/** The run's output pushed to the chat's object, where the feed is on. */
	readonly feed?: ClaudeCodeFeed;
};

const hooks = new Map<string, TurnHooks>();
const pauses = new Map<string, ClaudeStepPause>();
/**
 * Each turn's redaction list as its last step left it, kept in this isolate
 * so the chat's object can redact a preview between steps
 * (claude-feed-preview.ts). Lost with the isolate: then no preview is sent
 * and the step is woken instead.
 */
const redactions = new Map<string, () => readonly string[]>();

/** The executor registers the turn's hooks while it drives the turn. */
export function registerClaudeTurn(turnId: string, turn: TurnHooks) {
	hooks.set(turnId, turn);
	return () => {
		if (hooks.get(turnId) === turn) hooks.delete(turnId);
	};
}

/** Whether this turn may sleep between steps: registered and unwatched. */
export function claudeTurnMayPause(turnId: string) {
	if (!claudeFeedStepMayPause(turnId)) return false;
	const turn = hooks.get(turnId);
	if (!turn) return false;
	try {
		return !turn.watched();
	} catch {
		return false;
	}
}

/**
 * Whether a step following the run's feed may sleep between batches, watched
 * or not: its object previews the text to whoever watches and wakes the
 * step for anything else (claude-feed.ts).
 */
export function claudeFeedStepMayPause(turnId: string) {
	// Off switch for the edge executor's environment.
	if (process.env.YTIMESY_CLAUDE_STEP_PAUSE === "0") return false;
	return hooks.has(turnId);
}

/** The step's redaction list, for previews while no step runs. */
export function rememberClaudeTurnRedaction(
	turnId: string,
	redact: () => readonly string[],
) {
	redactions.set(turnId, redact);
}

/** The turn's redaction list, if this isolate still has it. */
export function claudeTurnRedaction(turnId: string) {
	return redactions.get(turnId);
}

/** The turn ended: nothing of it stays here. */
export function forgetClaudeTurn(turnId: string) {
	redactions.delete(turnId);
	pauses.delete(turnId);
}

/** The turn's feed, when its executor offers one (claude-feed.ts). */
export function claudeTurnFeed(turnId: string) {
	return hooks.get(turnId)?.feed;
}

/** The step ends early; its next one should start after `ms`. */
export function requestClaudeStepPause(turnId: string, ms: number) {
	pauses.set(turnId, { kind: "pause", ms });
}

/**
 * A feed step ends with nothing to do: the turn parks, its object waking
 * only to renew its leases until the feed or a call needs a step
 * (claude-parked-turn.ts).
 */
export function requestClaudeStepPark(turnId: string) {
	pauses.set(turnId, { kind: "park" });
}

/** How the step that just ended asked to sleep (taken once), else null. */
export function takeClaudeStepPause(turnId: string): ClaudeStepPause | null {
	const pause = pauses.get(turnId) ?? null;
	pauses.delete(turnId);
	return pause;
}
