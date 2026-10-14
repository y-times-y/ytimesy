/** The part of a Durable Object's SQLite storage the queue uses. */
type QueueSql = {
	exec<T extends Record<string, string | number | null>>(
		query: string,
		...bindings: (string | number | null)[]
	): { toArray(): T[] };
};

export type QueuedTurn = {
	turnId: string;
	leaseId: string;
	userId: string;
	sessionId: string;
};

/**
 * Turns admitted while this chat's previous turn is still settling. A chat
 * shows idle (after Stop or completion) a few seconds before its turn loop
 * ends, so a turn sent in that window waits here instead of being dropped.
 */
export class SqliteTurnQueue {
	constructor(
		private readonly sql: QueueSql,
		private readonly limit = 4,
	) {
		sql.exec(`create table if not exists turn_queue(
			seq integer primary key, turn_id text not null unique,
			user_id text not null, session_id text not null, lease_id text not null)`);
	}
	/** Idempotent for the same turn; false for a different lease or a full queue. */
	add(turn: QueuedTurn) {
		const queued = this.sql
			.exec<{ leaseId: string }>(
				"select lease_id as leaseId from turn_queue where turn_id=?",
				turn.turnId,
			)
			.toArray()[0];
		if (queued) return queued.leaseId === turn.leaseId;
		const waiting = this.sql
			.exec<{ count: number }>("select count(*) as count from turn_queue")
			.toArray()[0];
		if ((waiting?.count ?? 0) >= this.limit) return false;
		this.sql.exec(
			"insert into turn_queue(turn_id,user_id,session_id,lease_id) values(?,?,?,?)",
			turn.turnId,
			turn.userId,
			turn.sessionId,
			turn.leaseId,
		);
		return true;
	}
	/** Removes and returns the oldest waiting turn. */
	take(): QueuedTurn | undefined {
		const next = this.sql
			.exec<QueuedTurn>(
				`select turn_id as turnId,lease_id as leaseId,user_id as userId,
				 session_id as sessionId from turn_queue order by seq limit 1`,
			)
			.toArray()[0];
		if (next)
			this.sql.exec("delete from turn_queue where turn_id=?", next.turnId);
		return next;
	}
}
