import { cancelApiTurn } from "../adapters/api-turns";
import { coordinateConversationTurn } from "../adapters/conversation-turn-control";
import { abortLiveTurn } from "./live-turn-abort";

/** Persist stop intent first; worker fencing still stops the run when the coordinator is unreachable. */
export async function cancelServerTurn(userId: string, sessionId: string) {
	const turns = await cancelApiTurn(userId, sessionId);
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
