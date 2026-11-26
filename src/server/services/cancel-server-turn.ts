import { cancelApiTurn } from "../adapters/api-turns";
import { coordinateConversationTurn } from "../adapters/conversation-turn-control";
import { abortLiveTurn } from "./live-turn-abort";

/** Persist stop intent first; worker fencing still stops the run when the coordinator is unreachable. */
export async function cancelServerTurn(
	userId: string,
	sessionId: string,
	/** Who or what asked: one of `user-stop`, `archive`, `chat-delete`, `project-remove`, `account-delete`, `codex-session`. Logged, never shown. */
	reason = "unspecified",
) {
	const turns = await cancelApiTurn(userId, sessionId);
	// The only record of who set cancel_requested (2026-11-25: three turns were
	// stopped at once and nothing said by whom).
	for (const turn of turns)
		console.info(
			"turn.cancel_requested",
			JSON.stringify({ turnId: turn.id, sessionId, reason }),
		);
	// A turn running in this process stops at once; elsewhere its chat's
	// object stops it when the cancel below reaches it.
	for (const turn of turns) abortLiveTurn(turn.id);
	await Promise.all(
		turns
			.filter((turn) => turn.lease_id)
			.map((turn) =>
				coordinateConversationTurn("cancel", {
					userId,
					sessionId,
					turnId: turn.id,
					leaseId: turn.lease_id as string,
				}).catch(() => {
					console.warn(
						"Live cancellation delivery failed; durable stop intent remains recorded.",
					);
				}),
			),
	);
}
