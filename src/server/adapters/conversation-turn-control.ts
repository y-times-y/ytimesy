import type { TurnControl } from "#/domain/conversation-turn-control";
import { signDeliveryRequest } from "#/domain/delivery-auth";
import { realtimeDeliveryConfiguration } from "./realtime-delivery";

export async function coordinateConversationTurn(
	action: "acquire" | "renew" | "release" | "cancel",
	turn: TurnControl,
) {
	const config = realtimeDeliveryConfiguration();
	if (!config) return true;
	const url = `${config.url}/turn/${action}`;
	const body = JSON.stringify(turn);
	const response = await fetch(url, {
		method: "POST",
		headers: {
			...(await signDeliveryRequest(config.secret, "POST", url, body)),
			"Content-Type": "application/json",
		},
		body,
		signal: AbortSignal.timeout(5000),
	});
	if (response.status === 409) return false;
	if (!response.ok)
		throw new Error(
			`Conversation coordination unavailable (${response.status}).`,
		);
	return true;
}
