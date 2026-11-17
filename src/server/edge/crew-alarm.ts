import type { SqliteYSquaredCrew } from "./y-squared-crew-store";

/**
 * The crew's alarm: sends Y² its one debounced wake, and keeps the wake alive
 * when sending fails (a database hiccup, Y²'s chat not readable yet): the
 * changes stay pending and the alarm is set again, so a thread's turn end is
 * never dropped until the next note happens to come. The one alarm slot also
 * serves scheduled check-ins and stall signals (the store picks the earliest);
 * a wake that carries them is sent through the same path. Separate from the
 * Durable Object so it runs under test with a real store.
 */
export async function runCrewAlarm(input: {
	store: SqliteYSquaredCrew;
	now: number;
	/** Resolves true when the wake was enqueued into Y²'s chat (idle: it starts; busy: it queues behind the running turn). */
	enqueue: (
		target: { userId: string; sessionId: string },
		at: number,
		body: string,
	) => Promise<boolean>;
	setAlarm: (at: number) => Promise<void>;
	log: (line: string) => void;
}) {
	const { store, now } = input;
	const decided = store.takeWake(now);
	const log = (extra: Record<string, unknown>) =>
		input.log(
			`crew.wake ${JSON.stringify({
				action: decided.action,
				reason:
					decided.action === "send"
						? "due"
						: decided.action === "capped"
							? "hourly-cap"
							: "nothing-due",
				events: "eventsUpTo" in decided ? decided.eventsUpTo : null,
				...extra,
			})}`,
		);
	if (decided.action === "capped") {
		log({ enqueued: false });
		if (decided.retryAt !== undefined) await input.setAlarm(decided.retryAt);
		return;
	}
	if (decided.action === "none") {
		log({ enqueued: false });
		if (decided.rearmAt !== null) await input.setAlarm(decided.rearmAt);
		return;
	}
	// The next heartbeat, if a thread is still working.
	if (decided.rearmAt !== null) await input.setAlarm(decided.rearmAt);
	const target = store.target();
	if (!target) {
		log({ enqueued: false, skipped: "no-y2-target" });
		return;
	}
	let failure: string | null = null;
	try {
		const sent = await input.enqueue(
			target,
			decided.next.lastWakeAt,
			decided.body,
		);
		if (sent) {
			store.wakeSent(decided.eventsUpTo, decided.delivered, now);
			log({
				enqueued: true,
				proactive:
					decided.delivered.scheduleIds.length +
					decided.delivered.signals.length,
			});
			// What the wake carried moved on: the alarm may need the next one.
			const next = store.rearmAfterSend(now);
			if (next !== null) await input.setAlarm(next);
			return;
		}
		failure = "y2-chat-not-sendable";
	} catch (error) {
		failure = error instanceof Error ? error.message.slice(0, 200) : "error";
	}
	const retry = store.returnWake(now, decided.counted);
	log({ enqueued: false, error: failure, retryAt: retry.retryAt });
	if (retry.retryAt !== null) await input.setAlarm(retry.retryAt);
}
