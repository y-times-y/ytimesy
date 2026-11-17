import { Y_SQUARED_THREAD_LIMIT } from "../../domain/y-squared";
import {
	CREW_REPLY_LIMIT,
	CREW_RETENTION_MS,
	CREW_WAITING_HINT_TTL_MS,
	type CrewNote,
	type CrewRow,
	type CrewState,
	type CrewWaitingHint,
	crewNoteMatters,
	decideWake,
	type WakeState,
	wakeAlarmAt,
} from "../../domain/y-squared-crew";

type Binding = string | number | null;
/** The part of a Durable Object's SQLite storage the store uses. */
type CrewSql = {
	exec<T extends Record<string, Binding>>(
		query: string,
		...bindings: Binding[]
	): { toArray(): T[] };
};

type WakeRow = {
	pending: number;
	last_wake_at: number;
	wakes_this_hour: number;
	hour_start: number;
	alarm_at: number | null;
	user_id: string | null;
	y2_session_id: string | null;
	reconciled: number;
	pruned_at: number;
};

const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * One project's crew: a row per thread (rewritten in place, never one row per
 * turn) and the wake bookkeeping. All time comes in as an argument so the
 * debounce and the hourly cap test with a fake clock.
 */
export class SqliteYSquaredCrew {
	constructor(private readonly sql: CrewSql) {
		sql.exec(`create table if not exists crew(
			session_id text primary key, title text not null, state text not null,
			waiting_on text, pr_url text, last_reply text, updated_at integer not null)`);
		sql.exec(`create table if not exists wake_state(
			id integer primary key check(id=1), last_wake_at integer not null default 0,
			wakes_this_hour integer not null default 0, hour_start integer not null default 0,
			pending integer not null default 0, alarm_at integer, user_id text,
			y2_session_id text, reconciled integer not null default 0,
			pruned_at integer not null default 0)`);
		sql.exec("insert or ignore into wake_state(id) values(1)");
		// A thread's "waiting on the person" told ahead of its settle note.
		sql.exec(`create table if not exists waiting_hint(
			session_id text primary key, waiting_on text not null, at integer not null)`);
	}

	private wakeRow() {
		return this.sql
			.exec<WakeRow>("select * from wake_state where id=1")
			.toArray()[0] as WakeRow;
	}

	wakeState(): WakeState {
		const row = this.wakeRow();
		return {
			pending: row.pending === 1,
			lastWakeAt: row.last_wake_at,
			wakesThisHour: row.wakes_this_hour,
			hourStart: row.hour_start,
			alarmAt: row.alarm_at,
		};
	}

	private saveWake(state: WakeState) {
		this.sql.exec(
			`update wake_state set pending=?,last_wake_at=?,wakes_this_hour=?,
			 hour_start=?,alarm_at=? where id=1`,
			state.pending ? 1 : 0,
			state.lastWakeAt,
			state.wakesThisHour,
			state.hourStart,
			state.alarmAt,
		);
	}

	/** Who an alarm's wake goes to. */
	target() {
		const row = this.wakeRow();
		return row.user_id && row.y2_session_id
			? { userId: row.user_id, sessionId: row.y2_session_id }
			: null;
	}

	/**
	 * A settle note that lost what the thread waits on (the chat object's
	 * transcript copy was empty) takes it from the hint sent when the card was
	 * written. Any other note for the thread retires the hint (a new turn or
	 * a failure means the card no longer holds), so it never outlives its turn.
	 */
	private withWaitingHint(note: CrewNote, now: number): CrewNote {
		const hint = this.sql
			.exec<{ waiting_on: string; at: number }>(
				"select waiting_on,at from waiting_hint where session_id=?",
				note.sessionId,
			)
			.toArray()[0];
		if (!hint) return note;
		this.sql.exec(
			"delete from waiting_hint where session_id=?",
			note.sessionId,
		);
		if (
			note.state === "finished" &&
			!note.waitingOn &&
			now - hint.at <= CREW_WAITING_HINT_TTL_MS
		)
			return { ...note, state: "waiting", waitingOn: hint.waiting_on };
		return note;
	}

	/**
	 * A thread's turn ended on a card for the person. Kept for its settle note
	 * when that is still to come (the row says working or is unknown); a row
	 * the settle note already wrote as finished becomes waiting now. Y²'s own
	 * chat is never recorded.
	 */
	noteWaiting(hint: CrewWaitingHint, now: number): { alarmAt: number | null } {
		if (hint.ySquaredId && hint.sessionId === hint.ySquaredId)
			return { alarmAt: null };
		const existing = this.sql
			.exec<{
				title: string;
				state: string;
				waiting_on: string | null;
				pr_url: string | null;
				last_reply: string | null;
				updated_at: number;
			}>(
				"select title,state,waiting_on,pr_url,last_reply,updated_at from crew where session_id=?",
				hint.sessionId,
			)
			.toArray()[0];
		// Already settled as finished within the hint's life: upgrade it now.
		if (
			existing?.state === "finished" &&
			!existing.waiting_on &&
			now - existing.updated_at <= CREW_WAITING_HINT_TTL_MS
		)
			return this.noteThread(
				{
					sessionId: hint.sessionId,
					title: existing.title,
					state: "waiting",
					waitingOn: hint.waitingOn,
					prUrl: existing.pr_url,
					lastReply: existing.last_reply,
					userId: hint.userId,
					projectId: hint.projectId,
					ySquaredId: hint.ySquaredId,
				},
				now,
			);
		if (existing && existing.state !== "working") return { alarmAt: null };
		this.sql.exec(
			`insert into waiting_hint(session_id,waiting_on,at) values(?,?,?)
			 on conflict(session_id) do update set waiting_on=excluded.waiting_on,at=excluded.at`,
			hint.sessionId,
			hint.waitingOn,
			now,
		);
		return { alarmAt: null };
	}

	/**
	 * Records one thread's state: one upsert, skipped entirely when nothing
	 * changed. Returns the time to set the wake alarm for (null: none to set).
	 * Y²'s own chat is never recorded and never wakes.
	 */
	noteThread(note: CrewNote, now: number): { alarmAt: number | null } {
		if (note.ySquaredId && note.sessionId === note.ySquaredId)
			return { alarmAt: null };
		note = this.withWaitingHint(note, now);
		const existing = this.sql
			.exec<{
				title: string;
				state: string;
				waiting_on: string | null;
				pr_url: string | null;
				last_reply: string | null;
			}>(
				"select title,state,waiting_on,pr_url,last_reply from crew where session_id=?",
				note.sessionId,
			)
			.toArray()[0];
		const title = existing?.title || note.title;
		const reply = note.lastReply?.slice(0, CREW_REPLY_LIMIT) ?? null;
		const unchanged =
			existing &&
			existing.state === note.state &&
			existing.waiting_on === note.waitingOn &&
			existing.pr_url === note.prUrl &&
			// A working note carries no reply: keep the last one shown.
			(note.state === "working" || existing.last_reply === reply) &&
			existing.title === title;
		if (!unchanged) {
			this.sql.exec(
				`insert into crew(session_id,title,state,waiting_on,pr_url,last_reply,updated_at)
				 values(?,?,?,?,?,?,?)
				 on conflict(session_id) do update set title=excluded.title,state=excluded.state,
				 waiting_on=excluded.waiting_on,pr_url=excluded.pr_url,
				 last_reply=coalesce(excluded.last_reply,crew.last_reply),
				 updated_at=excluded.updated_at`,
				note.sessionId,
				title,
				note.state,
				note.waitingOn,
				note.prUrl,
				note.state === "working" ? null : reply,
				now,
			);
		}
		const wake = this.wakeRow();
		const stale =
			wake.user_id !== note.userId ||
			wake.y2_session_id !== (note.ySquaredId ?? wake.y2_session_id);
		let alarmAt: number | null = null;
		const matters = !unchanged && crewNoteMatters(note.state);
		if (stale || matters) {
			this.sql.exec(
				"update wake_state set user_id=?,y2_session_id=coalesce(?,y2_session_id) where id=1",
				note.userId,
				note.ySquaredId,
			);
		}
		if (matters && (note.ySquaredId || wake.y2_session_id)) {
			const state = { ...this.wakeState(), pending: true };
			alarmAt = wakeAlarmAt(state, now);
			this.saveWake({ ...state, alarmAt: alarmAt ?? state.alarmAt });
		}
		if (now - wake.pruned_at >= PRUNE_EVERY_MS) this.prune(now);
		return { alarmAt };
	}

	/** Drops threads untouched for 30 days. */
	prune(now: number) {
		this.sql.exec(
			"delete from crew where updated_at<?",
			now - CREW_RETENTION_MS,
		);
		this.sql.exec(
			"delete from waiting_hint where at<?",
			now - CREW_WAITING_HINT_TTL_MS,
		);
		this.sql.exec("update wake_state set pruned_at=? where id=1", now);
	}

	/** Threads that need the person first (waiting, failed), then working, then the rest, newest first. */
	list(limit = Y_SQUARED_THREAD_LIMIT): {
		reconciled: boolean;
		rows: CrewRow[];
	} {
		const rows = this.sql
			.exec<{
				session_id: string;
				title: string;
				state: string;
				waiting_on: string | null;
				pr_url: string | null;
				last_reply: string | null;
				updated_at: number;
			}>(
				`select * from crew order by
				 case state when 'waiting' then 0 when 'failed' then 0 when 'working' then 1 else 2 end,
				 updated_at desc limit ?`,
				Math.min(limit, Y_SQUARED_THREAD_LIMIT),
			)
			.toArray();
		return {
			reconciled: this.wakeRow().reconciled === 1,
			rows: rows.map(toRow),
		};
	}

	thread(sessionId: string): CrewRow | null {
		const row = this.sql
			.exec<Parameters<typeof toRow>[0]>(
				"select * from crew where session_id=?",
				sessionId,
			)
			.toArray()[0];
		return row ? toRow(row) : null;
	}

	/**
	 * The cold start's one fill from the sidebar's metadata. Rows a note
	 * already wrote win; nothing changes once reconciled.
	 */
	reconcile(rows: readonly CrewRow[], limit = Y_SQUARED_THREAD_LIMIT) {
		if (this.wakeRow().reconciled === 1) return false;
		for (const row of rows.slice(0, limit))
			this.sql.exec(
				`insert or ignore into crew(session_id,title,state,waiting_on,pr_url,last_reply,updated_at)
				 values(?,?,?,?,?,?,?)`,
				row.sessionId,
				row.title,
				row.state,
				row.waitingOn,
				row.prUrl,
				row.lastReply?.slice(0, CREW_REPLY_LIMIT) ?? null,
				row.updatedAt,
			);
		this.sql.exec("update wake_state set reconciled=1 where id=1");
		return true;
	}

	/** The alarm fired. */
	takeWake(now: number) {
		const decided = decideWake(this.wakeState(), now);
		this.saveWake(
			decided.action === "capped"
				? { ...decided.next, alarmAt: decided.retryAt ?? null }
				: decided.next,
		);
		return decided;
	}

	/** The wake could not be enqueued: hand it back for the next note to re-arm. */
	returnWake() {
		const state = this.wakeState();
		this.saveWake({
			...state,
			pending: true,
			wakesThisHour: Math.max(0, state.wakesThisHour - 1),
			alarmAt: null,
		});
	}
}

function toRow(row: {
	session_id: string;
	title: string;
	state: string;
	waiting_on: string | null;
	pr_url: string | null;
	last_reply: string | null;
	updated_at: number;
}): CrewRow {
	return {
		sessionId: row.session_id,
		title: row.title,
		state: row.state as CrewState,
		waitingOn: row.waiting_on,
		prUrl: row.pr_url,
		lastReply: row.last_reply,
		updatedAt: row.updated_at,
	};
}
