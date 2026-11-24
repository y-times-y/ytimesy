import { Cause, Effect } from "effect";
import { TURN_ALREADY_RUNNING } from "#/domain/api-turn-failure";

/** Whether a failed send was refused only because a turn started first. */
export function isTurnAlreadyRunningRefusal(
	error: unknown,
	depth = 0,
): boolean {
	if (depth > 6 || !error || typeof error !== "object") return false;
	const record = error as {
		message?: unknown;
		cause?: unknown;
		error?: unknown;
	};
	if (
		typeof record.message === "string" &&
		record.message.includes(TURN_ALREADY_RUNNING)
	)
		return true;
	return (
		isTurnAlreadyRunningRefusal(record.cause, depth + 1) ||
		isTurnAlreadyRunningRefusal(record.error, depth + 1)
	);
}

/**
 * A person's send that lost the race for its chat's turn (a Y² wake or a
 * queued message started one between the send's check and its insert) is
 * queued behind that turn instead of refused: the chat answers it next. It
 * was refused with "Finish or stop the current turn…", and the composer took
 * the message back, sometimes without returning it to the box (2026-11-24,
 * the Y² chat: "my user prompt disappeared and never got answered").
 * `queueBehind` is null where queueing is not allowed (a merged batch, a
 * message the queue itself delivers); any other failure is left as it was.
 */
export function sendQueuingBehindRace<A>(
	send: Effect.Effect<A>,
	queueBehind: (() => Promise<A | null>) | null,
): Effect.Effect<A> {
	if (!queueBehind) return send;
	return Effect.catchCause(send, (cause) =>
		isTurnAlreadyRunningRefusal(Cause.squash(cause))
			? Effect.flatMap(
					Effect.promise(() => queueBehind().catch(() => null)),
					(queued) => {
						if (queued === null) return Effect.failCause(cause);
						console.warn(JSON.stringify({ event: "send.queued_behind_race" }));
						return Effect.succeed(queued);
					},
				)
			: Effect.failCause(cause),
	);
}
