import { cancelApiTurn } from "../adapters/api-turns";
import { coordinateConversationTurn } from "../adapters/conversation-turn-control";

/** Persist stop intent first; worker fencing still stops the run when the coordinator is unreachable. */
export async function cancelServerTurn(userId: string, sessionId: string) {
	const turns = await cancelApiTurn(userId, sessionId);
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
