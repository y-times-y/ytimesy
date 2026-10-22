import { z } from "zod";
import { signDeliveryRequest } from "#/domain/delivery-auth";
import { modelConcurrencyLimits } from "./agent-capacity";
import { claimApiTurn, releaseClaimedApiTurn } from "./api-turns";
import {
	backgroundAdmissionEndpoint,
	hasInternalJobDispatcher,
} from "./background-job-dispatch";
import { executorFetch, hasExecutorBinding } from "./executor-fetch";

/** A claimed turn handed to its chat's loop (ModelConversation.startTurn). */
export const turnStartRequest = z
	.object({
		userId: z.string().min(1).max(256),
		sessionId: z.string().uuid(),
		turnId: z.string().uuid(),
		leaseId: z.string().uuid(),
	})
	.strict();
export type TurnStartRequest = z.infer<typeof turnStartRequest>;

/** Starts one claimed turn in its chat; false when the chat would not take it. */
export type StartClaimedTurn = (turn: TurnStartRequest) => Promise<boolean>;

/**
 * Claims queued chat turns (within the concurrency limits, oldest first) and
 * starts each in its chat's ModelConversation. Safe to repeat and to run
 * from several places at once: a claim takes a turn exactly once, so a second
 * pass finds nothing. Runs inside a database scope.
 */
export async function admitQueuedTurnsWith(start: StartClaimedTurn) {
	const limits = modelConcurrencyLimits();
	for (let count = 0; count < 16; count++) {
		const turn = await claimApiTurn(
			limits.perUser,
			limits.fleet,
			"durable-object",
		);
		if (!turn) break;
		if (!turn.lease_id) throw new Error("Claimed turn has no lease.");
		let started: boolean;
		try {
			started = await start({
				userId: turn.user_id,
				sessionId: turn.session_id,
				turnId: turn.id,
				leaseId: turn.lease_id,
			});
		} catch (error) {
			// The hand-off failed: queue the turn again so the caller's fallback
			// (the admission job) or the next sweep starts it now, not after its
			// lease runs out.
			await releaseClaimedApiTurn(turn.id, turn.lease_id).catch(() =>
				console.warn("A claimed turn could not be released."),
			);
			throw error;
		}
		if (!started)
			console.warn(
				"Chat could not queue this turn; lease expiry will fail it.",
			);
	}
}

/**
 * The web Worker's wake for a sent message: it claims on its own (already
 * open) database connection and hands each claimed turn to its chat through
 * the executor's service binding (POST /turn/start), instead of asking the
 * executor to run an admission (a fresh invocation and database connection)
 * first. False when this is not the web Worker (the Node server, an edge
 * invocation, the rehearsal) or no admission endpoint is configured; the
 * caller then dispatches the admission job as before. The minute's admission
 * sweep stays the safety net either way.
 */
export async function startQueuedTurnsDirectly(): Promise<boolean> {
	if (hasInternalJobDispatcher() || !hasExecutorBinding()) return false;
	const endpoint = backgroundAdmissionEndpoint();
	if (!endpoint) return false;
	const url = new URL("/turn/start", endpoint.origin).href;
	await admitQueuedTurnsWith(async (turn) => {
		const body = JSON.stringify(turnStartRequest.parse(turn));
		// startTurn is idempotent for the same turn and lease: one resend is safe.
		for (let attempt = 0; ; attempt++) {
			try {
				const response = await executorFetch(url, {
					method: "POST",
					body,
					redirect: "manual",
					signal: AbortSignal.timeout(10_000),
					headers: {
						...(await signDeliveryRequest(endpoint.secret, "POST", url, body)),
						"content-type": "application/json",
					},
				});
				await response.body?.cancel().catch(() => {});
				if (response.status === 204) return true;
				if (response.status === 409) return false;
				throw new Error("Turn start failed.");
			} catch (error) {
				if (attempt >= 1) throw error;
			}
		}
	});
	return true;
}
