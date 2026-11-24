import { AsyncLocalStorage } from "node:async_hooks";
import { Effect, Schedule } from "effect";
import {
	CoordinationFailure,
	type TurnControl,
	type TurnControlAction,
} from "#/domain/conversation-turn-control";
import { signDeliveryRequest } from "#/domain/delivery-auth";
import { executorFetch } from "./executor-fetch";
import { realtimeDeliveryConfiguration } from "./realtime-delivery";

const local = new AsyncLocalStorage<
	(action: TurnControlAction, turn: TurnControl) => Promise<boolean>
>();
export function withConversationTurnCoordinator<T>(
	coordinate: (
		action: TurnControlAction,
		turn: TurnControl,
	) => Promise<boolean>,
	run: () => Promise<T>,
) {
	return local.run(coordinate, run);
}

export async function coordinateConversationTurn(
	action: TurnControlAction,
	turn: TurnControl,
) {
	const coordinate = local.getStore();
	if (coordinate) return coordinate(action, turn);
	const config = realtimeDeliveryConfiguration();
	if (!config) return true;
	const url = `${config.url}/turn/${action}`;
	const body = JSON.stringify(turn);
	let attempts = 0;
	const request = Effect.tryPromise({
		try: async () => {
			attempts++;
			const response = await executorFetch(url, {
				method: "POST",
				headers: {
					...(await signDeliveryRequest(config.secret, "POST", url, body)),
					"Content-Type": "application/json",
				},
				body,
				signal: AbortSignal.timeout(5000),
			});
			if (response.status === 409) return false;
			if (!response.ok) {
				await response.body?.cancel().catch(() => {});
				throw new CoordinationFailure(
					action,
					{ kind: "http", status: response.status },
					attempts,
				);
			}
			return true;
		},
		catch: (error) =>
			error instanceof TypeError ||
			(error instanceof DOMException && error.name === "TimeoutError")
				? new CoordinationFailure(
						action,
						{
							kind: "transport",
							category: error instanceof TypeError ? "network" : "timeout",
						},
						attempts,
					)
				: error,
	});
	// Renewals are identity-bound and idempotent. Two 5s requests plus 250ms
	// backoff leave headroom inside the 30s lease renewed every 10s.
	const result = await Effect.runPromise(
		request.pipe(
			Effect.retry({
				schedule: Schedule.spaced("250 millis"),
				times: action === "renew" ? 1 : 0,
				while: (error) =>
					error instanceof CoordinationFailure && error.retryable,
			}),
			Effect.result,
		),
	);
	if (result._tag === "Failure") throw result.failure;
	return result.success;
}
