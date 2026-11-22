type Sql = {
	exec<T extends Record<string, string | number | null>>(
		query: string,
		...bindings: (string | number | null)[]
	): { toArray(): T[] };
};

/**
 * What the object's alarm did about its recorded wake-ups at startup.
 * "armed": the platform had dropped the alarm, so it was set again.
 * "alarm-set": the platform still holds one; nothing to do.
 * "nothing-to-run": no turn and no wake-up is recorded.
 */
export type TurnAlarmRepair = "armed" | "alarm-set" | "nothing-to-run";

/**
 * Cloudflare re-runs a failed alarm a few times and then drops it. An outage
 * of this object's storage that outlasts those retries leaves a running turn
 * (or a room lease expiry) recorded in the object's own tables with no alarm
 * behind it, and nothing would ever run it again: the turn's heartbeat stops
 * until lease expiry fails it. Run at startup (a reset object starts again on
 * its next request), this sets the alarm again from what the tables record.
 * A turn with no recorded wake is resumed at once; its step receipt says
 * whether the step it was in is continued. Safe to repeat or to race a late
 * platform retry: the alarm's `stepping` guard and the receipts keep one step
 * running at a time. Separate from the Durable Object so it runs under test.
 */
export async function rearmLostTurnAlarm(input: {
	sql: Sql;
	now: number;
	getAlarm: () => Promise<number | null>;
	setAlarm: (at: number) => Promise<void>;
	log: (line: string) => void;
}): Promise<TurnAlarmRepair> {
	const { sql, now } = input;
	const turn = sql
		.exec<{ n: number }>("select count(*) as n from turn_loop")
		.toArray()[0];
	const hasTurn = (turn?.n ?? 0) > 0;
	const wakes = sql
		.exec<{ purpose: string; at: number }>(
			"select purpose,at from conversation_wake",
		)
		.toArray();
	if (!hasTurn && wakes.length === 0) return "nothing-to-run";
	if ((await input.getAlarm()) !== null) return "alarm-set";
	let at = wakes.length > 0 ? Math.min(...wakes.map((wake) => wake.at)) : now;
	if (hasTurn && !wakes.some((wake) => wake.purpose === "turn")) {
		sql.exec(
			"insert into conversation_wake values('turn',?) on conflict(purpose) do update set at=excluded.at",
			now,
		);
		at = Math.min(at, now);
	}
	await input.setAlarm(Math.max(at, now));
	input.log(
		`turn.alarm_rearmed ${JSON.stringify({ hasTurn, wakes: wakes.map((wake) => wake.purpose), lateMs: Math.max(0, now - at) })}`,
	);
	return "armed";
}
