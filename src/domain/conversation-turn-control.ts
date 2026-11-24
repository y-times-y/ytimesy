import { z } from "zod";

export const turnControlSchema = z.object({
	userId: z.string().min(1).max(200),
	sessionId: z.string().uuid(),
	turnId: z.string().uuid(),
	leaseId: z.string().uuid(),
	/**
	 * A holder that is not a turn: a code restore holding the chat's lock
	 * (conversation-turn-settled.ts). A takeover never takes the lock from a
	 * live one; a stale turn's lock it does.
	 */
	hold: z.literal("restore").optional(),
});
export type TurnControl = z.infer<typeof turnControlSchema>;
/** Deletes a chat's Durable Object state when the chat, its project or its account goes. */
export const conversationPurgeSchema = turnControlSchema.pick({
	userId: true,
	sessionId: true,
});
export type ActiveConversationTurn = TurnControl & {
	expiresAt: number;
	cancelled: boolean;
};
export const TURN_COORDINATION_LEASE_MS = 30_000;
/**
 * How long a turn the room let go (released, lapsed or replaced) may not
 * take it again: longer than its Postgres lease can outlive its room lease
 * (45 s against 30 s; a parked Claude Code turn's 150 s against 120 s,
 * claude-parked-turn.ts), so a lapsed turn cannot come back while
 * Postgres still takes its writes.
 */
export const RETIRED_TURN_MS = 70_000;

/**
 * A retirement names the turn's lease, not just the turn. Every claim in
 * Postgres gives a turn a new random lease and every write checks it, so a
 * retired lease can never write again once the turn is claimed anew; the
 * turn's next owner (a box taking over a dead box's turn, the chat's object
 * taking a turn a box handed over, an admission after a requeue) acquires
 * under its own lease. Retiring the turn ID itself refused every such owner
 * for 70 s and failed the turn ("could not confirm this turn's ownership",
 * 2026-11-23). Entries written before this change are keyed by the turn ID
 * alone; they are still honoured and expire within RETIRED_TURN_MS.
 */
export function retiredLeaseKey(turn: { turnId: string; leaseId: string }) {
	return `${turn.turnId}:${turn.leaseId}`;
}

/**
 * "handoff" lets the room go of a turn that is being moved to another
 * executor under a new lease (a box handing a turn to the chat's object): the
 * room forgets the turn without retiring it, so the new executor can acquire
 * the same turn. "release" retires the turn for RETIRED_TURN_MS; a hand-off
 * that released instead made the object's acquire wait out its whole window
 * (35 s of a 70 s retirement) and fail the turn.
 *
 * "resume" takes the lease back for a running turn whose room lease lapsed
 * (its renewals were late: a box's port call hung, the room restarted) while
 * Postgres still confirms the turn owns its lease, not cancelled: the caller
 * renews Postgres first. Refused while another lease holds the room or the
 * turn was stopped. Without it such a turn was stopped mid-work ("Run
 * stopped. Conversation coordination lease was lost", 2026-11-23).
 *
 * "takeover" is the chat's one active turn (Postgres allows one, and the
 * caller has just renewed it there) taking the lock from whatever the room
 * still names: a turn that ended or was failed without releasing it, or a
 * box that went on after its lease was lost, is stale by that fact, and its
 * own renewals are then refused. Never from a live code restore (`hold`),
 * and never for a turn that was stopped. A turn used to wait for such a
 * holder and, after 105 s, fail with "This turn did not start…", or a
 * later step failed the same way after a lapse (2026-11-24: a 14 minute
 * turn ended with it).
 */
export type TurnControlAction =
	| "acquire"
	| "renew"
	| "release"
	| "handoff"
	| "resume"
	| "takeover"
	| "cancel";
type CoordinationFailureReason =
	| { kind: "http"; status: number }
	| { kind: "transport"; category: "timeout" | "network" };

/** Contains only bounded diagnostics, never response bodies, URLs or credentials. */
export class CoordinationFailure extends Error {
	constructor(
		readonly action: TurnControlAction,
		readonly failure: CoordinationFailureReason,
		readonly attempts: number,
	) {
		const reason =
			failure.kind === "http" ? `HTTP ${failure.status}` : failure.category;
		super(
			`Conversation coordination failed during ${action} (${reason}, ${attempts} attempt${attempts === 1 ? "" : "s"}). Execution stopped; inspect preserved work before continuing. No model fallback or stream replay was used.`,
		);
		this.name = "CoordinationFailure";
	}
	get retryable() {
		return (
			this.failure.kind === "transport" ||
			this.failure.status === 429 ||
			this.failure.status >= 500
		);
	}
}
