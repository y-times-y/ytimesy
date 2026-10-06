import { Effect, Schedule } from "effect";
import type { TurnControl } from "#/domain/conversation-turn-control";
import { signDeliveryRequest } from "#/domain/delivery-auth";
import { realtimeDeliveryConfiguration } from "./realtime-delivery";

class RetryableCoordinationFailure extends Error {}

export async function coordinateConversationTurn(
	action: "acquire" | "renew" | "release" | "cancel",
	turn: TurnControl,
) {
	const config = realtimeDeliveryConfiguration();
	if (!config) return true;
	const url = `${config.url}/turn/${action}`;
	const body = JSON.stringify(turn);
	const request = Effect.tryPromise({
		try: async () => {
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
			if (response.status === 429 || response.status >= 500) {
				await response.body?.cancel();
				throw new RetryableCoordinationFailure(
					"Conversation coordination temporarily unavailable.",
				);
			}
			if (!response.ok)
				throw new Error(
					`Conversation coordination unavailable (${response.status}).`,
				);
			return true;
		},
		catch: (error) =>
			error instanceof TypeError ||
			(error instanceof DOMException && error.name === "TimeoutError")
				? new RetryableCoordinationFailure(
						"Conversation coordination transport unavailable.",
						{ cause: error },
					)
				: error,
	});
	// Renewals are identity-bound and idempotent. Two 5s requests plus 250ms
	// backoff leave headroom inside the 30s lease renewed every 10s.
	const result = await Effect.runPromise(
		request.pipe(
			Effect.retry({
				schedule: Schedule.intersect(
					Schedule.recurs(action === "renew" ? 1 : 0),
					Schedule.spaced("250 millis"),
				),
				while: (error) => error instanceof RetryableCoordinationFailure,
			}),
			Effect.either,
		),
	);
	if (result._tag === "Left") throw result.left;
	return result.right;
}
