import {
	type ClaudeFeedMode,
	type ClaudeFeedState,
	claudeStepSource,
	feedWakeAt,
} from "./claude-feed";

/**
 * A Claude Code turn whose step follows the run's feed and has nothing to
 * do is parked: its chat object sleeps, and wakes only to renew the turn's
 * leases (Postgres and the room) without running a step. Feed lines, an MCP
 * call, Stop or a turn queued behind it still wake a real step at once
 * (they reschedule the turn's wake, which unparks it).
 *
 * The windows keep a parked turn alive across the spacing:
 *  - the room lease of a parked turn outlasts the spacing (the room's own
 *    alarm would otherwise expire it first);
 *  - Postgres accepts a Claude Code turn of a chat object that renewed
 *    within CLAUDE_TURN_LEASE_SECONDS (apiTurnLeaseFreshSql), still inside
 *    the three minutes after which expireApiTurnLeases fails it;
 *  - a room lease that lapses retires the turn for RETIRED_TURN_MS, longer
 *    than its Postgres lease can outlive the room's.
 */
export const CLAUDE_PARKED_RENEW_MS = 75_000;
export const CLAUDE_PARKED_ROOM_LEASE_MS = 120_000;
export const CLAUDE_TURN_LEASE_SECONDS = 150;

/** How a Claude Code step that ended early asked to sleep. */
export type ClaudeStepPause =
	/** A polling step: look at the run again after `ms`. */
	| { readonly kind: "pause"; readonly ms: number }
	/** A feed step with nothing to do: park until the feed or a call wakes it. */
	| { readonly kind: "park" };

/** Feed lines that arrived after the step's last read. */
export type UnreadFeed = {
	readonly urgent: boolean;
	readonly mode: ClaudeFeedMode;
	readonly pendingSince: number;
};

/**
 * When the turn's next wake is after a step that continues, and whether it
 * is a parked renewal. A park becomes a short pause while a turn waits
 * behind this one (its lease is refreshed only by steps), and nothing
 * sleeps with a call waiting; unread lines bring the wake forward
 * (feedWakeAt), and a wake for lines is a step, never a renewal.
 */
export function claudeStepWake(input: {
	readonly now: number;
	readonly pause: ClaudeStepPause | null;
	readonly pendingCalls: number;
	readonly waitingTurns: number;
	readonly unread: UnreadFeed | null;
	/** The pause a park falls back to while another turn waits. */
	readonly fallbackPauseMs: number;
}): { readonly at: number; readonly parked: boolean } {
	const { now, pause } = input;
	let at = now;
	let parked = false;
	if (pause && input.pendingCalls === 0) {
		if (pause.kind === "pause") at = now + pause.ms;
		else if (input.waitingTurns > 0) at = now + input.fallbackPauseMs;
		else {
			at = now + CLAUDE_PARKED_RENEW_MS;
			parked = true;
		}
	}
	if (!input.unread) return { at, parked };
	const due = feedWakeAt({
		now,
		urgent: input.unread.urgent,
		mode: input.unread.mode,
		pendingSince: input.unread.pendingSince,
		scheduledAt: at,
	});
	return { at: due, parked: parked && due >= at };
}

/** Why a parked turn's wake runs a step instead of only renewing. */
export type ParkedRenewRefusal =
	| "not-parked"
	| "feed-silent"
	| "feed-unread"
	| "feed-exited"
	| "call-pending"
	| "turn-waiting"
	| "room-lease"
	| "cancelled";

/**
 * Whether a parked turn's wake may only renew its leases: it parked (and
 * nothing rescheduled it since), its runner is still heard, every stored
 * line was read, no MCP call is queued, no turn waits behind it, and the
 * room still holds its lease uncancelled. Anything else: a step runs.
 */
export function parkedTurnRenewal(input: {
	readonly parked: boolean;
	readonly now: number;
	/** The run's feed, `lastSeen` as last heard (pings included). */
	readonly feed: ClaudeFeedState | null;
	readonly pendingCalls: number;
	readonly waitingTurns: number;
	/** The room's lease of this turn (same turn and lease), null if it holds none. */
	readonly room: {
		readonly expiresAt: number;
		readonly cancelled: boolean;
	} | null;
}):
	| { readonly renew: true }
	| { readonly renew: false; readonly reason: ParkedRenewRefusal } {
	const refuse = (reason: ParkedRenewRefusal) =>
		({ renew: false, reason }) as const;
	if (!input.parked) return refuse("not-parked");
	const { feed } = input;
	if (!feed || claudeStepSource(feed, input.now) !== "feed")
		return refuse("feed-silent");
	if (feed.exitStatus !== null) return refuse("feed-exited");
	if (feed.receivedTo > feed.consumedTo) return refuse("feed-unread");
	if (input.pendingCalls > 0) return refuse("call-pending");
	if (input.waitingTurns > 0) return refuse("turn-waiting");
	if (!input.room || input.room.expiresAt <= input.now)
		return refuse("room-lease");
	if (input.room.cancelled) return refuse("cancelled");
	return { renew: true };
}
