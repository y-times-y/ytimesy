import { Y_SQUARED_THREAD_LIMIT } from "../../domain/y-squared";
import {
	CREW_EVENT_LIMIT,
	CREW_REPLY_LIMIT,
	CREW_REQUEST_LIMIT,
	CREW_RETENTION_MS,
	CREW_STARTED_WAKE_EVERY_MS,
	CREW_WAITING_HINT_TTL_MS,
	CREW_WAKE_RETRIES,
	CREW_Y2_SENT_TTL_MS,
	type CrewNote,
	type CrewRow,
	type CrewState,
	type CrewWaitingHint,
	type CrewWakeEvent,
	crewNoteMatters,
	crewTitle,
	crewWakeBody,
	crewWakeDelayMs,
	crewWakeDueAt,
	decideWake,
	heartbeatDueAt,
	type WakeState,
	wakeRetryDelayMs,
} from "../../domain/y-squared-crew";
import {
	decideProactive,
	nextDueAt,
	nextTypicalWorkMs,
	proactiveWakeLines,
	type ScheduleDraft,
	type ScheduleSpec,
	type ScheduleStatus,
	type ScheduleView,
	type StallRow,
	type StallSignal,
	stallAfterMs,
	stallClockFrom,
	stallDueAt,
	stallSignals,
	Y_SQUARED_DAY_MS,
	Y_SQUARED_ONCE_MISSED_AFTER_MS,
	Y_SQUARED_PROACTIVE_WAKES_PER_DAY,
	Y_SQUARED_SCHEDULE_KEEP_MS,
	Y_SQUARED_SCHEDULE_LIMIT,
	type YSquaredSettings,
} from "../../domain/y-squared-proactive";

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
	pending_due_at: number | null;
	last_heartbeat_at: number;
	wake_failures: number;
	proactive_day_start: number;
	proactive_today: number;
	proactive_hold_until: number;
	stall_nudges: number;
	timezone: string | null;
};

type ScheduleRow = {
	id: string;
	prompt: string;
	spec: string;
	tz: string;
	status: string;
	next_due_at: number | null;
	last_run_at: number | null;
};

/** What one wake carries beyond its events: due schedules and stall signals, consumed once it was enqueued. */
export type DeliveredProactive = {
	readonly scheduleIds: readonly string[];
	readonly signals: readonly StallSignal[];
};
const NO_PROACTIVE: DeliveredProactive = { scheduleIds: [], signals: [] };

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
			waiting_on text, pr_url text, last_reply text, updated_at integer not null,
			created_at integer not null default 0, last_request text,
			last_active_at integer not null default 0, working_since integer,
			start_wake_at integer not null default 0)`);
		// A table an earlier deploy made lacks the newer columns: add them,
		// once each. Old rows keep working: created is "not recorded" (0) and
		// the last activity is taken from their last note.
		const columns = new Set(
			sql
				.exec<{ name: string }>("select name from pragma_table_info('crew')")
				.toArray()
				.map((column) => column.name),
		);
		if (!columns.has("created_at"))
			sql.exec(
				"alter table crew add column created_at integer not null default 0",
			);
		if (!columns.has("last_request"))
			sql.exec("alter table crew add column last_request text");
		if (!columns.has("last_active_at")) {
			sql.exec(
				"alter table crew add column last_active_at integer not null default 0",
			);
			sql.exec("update crew set last_active_at=updated_at");
		}
		if (!columns.has("working_since"))
			sql.exec("alter table crew add column working_since integer");
		if (!columns.has("start_wake_at"))
			sql.exec(
				"alter table crew add column start_wake_at integer not null default 0",
			);
		// Stall signals: a moving average of this thread's turn durations, the
		// working run already nudged, the waiting reminders already sent, and
		// the last real progress its running turn showed (checked in Postgres
		// when a stall comes due; 0: not checked this run).
		for (const column of [
			"typical_work_ms",
			"stall_nudged_for",
			"reminded_at",
			"remind_n",
			"progress_at",
		])
			if (!columns.has(column))
				sql.exec(
					`alter table crew add column ${column} integer not null default 0`,
				);
		sql.exec(`create table if not exists wake_state(
			id integer primary key check(id=1), last_wake_at integer not null default 0,
			wakes_this_hour integer not null default 0, hour_start integer not null default 0,
			pending integer not null default 0, alarm_at integer, user_id text,
			y2_session_id text, reconciled integer not null default 0,
			pruned_at integer not null default 0)`);
		sql.exec("insert or ignore into wake_state(id) values(1)");
		const wakeColumns = new Set(
			sql
				.exec<{ name: string }>(
					"select name from pragma_table_info('wake_state')",
				)
				.toArray()
				.map((column) => column.name),
		);
		if (!wakeColumns.has("pending_due_at"))
			sql.exec("alter table wake_state add column pending_due_at integer");
		if (!wakeColumns.has("last_heartbeat_at"))
			sql.exec(
				"alter table wake_state add column last_heartbeat_at integer not null default 0",
			);
		if (!wakeColumns.has("wake_failures"))
			sql.exec(
				"alter table wake_state add column wake_failures integer not null default 0",
			);
		for (const [column, type] of [
			["proactive_day_start", "integer not null default 0"],
			["proactive_today", "integer not null default 0"],
			["proactive_hold_until", "integer not null default 0"],
			["stall_nudges", "integer not null default 1"],
			["timezone", "text"],
		] as const)
			if (!wakeColumns.has(column))
				sql.exec(`alter table wake_state add column ${column} ${type}`);
		// The person's scheduled check-ins (at most 10 active).
		sql.exec(`create table if not exists schedules(
			id text primary key, prompt text not null, spec text not null, tz text not null,
			status text not null, next_due_at integer, last_run_at integer, created_at integer not null)`);
		// What changed since Y²'s last wake (told in the next wake's message),
		// and the sends Y² itself made (so its threads' starts are not "the person's").
		sql.exec(`create table if not exists wake_events(
			id integer primary key autoincrement, kind text not null,
			session_id text not null, title text not null, detail text, at integer not null)`);
		sql.exec(`create table if not exists y2_sent(
			id integer primary key autoincrement, session_id text not null, at integer not null)`);
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
				last_request: string | null;
				updated_at: number;
			}>(
				"select title,state,waiting_on,pr_url,last_reply,last_request,updated_at from crew where session_id=?",
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
					lastRequest: existing.last_request,
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
				last_request: string | null;
				start_wake_at: number;
				working_since: number | null;
				typical_work_ms: number;
			}>(
				"select title,state,waiting_on,pr_url,last_reply,last_request,start_wake_at,working_since,typical_work_ms from crew where session_id=?",
				note.sessionId,
			)
			.toArray()[0];
		// A row never stays untitled while its note or its request names it.
		const title = existing?.title || note.title || crewTitle(note.lastRequest);
		const reply = note.lastReply?.slice(0, CREW_REPLY_LIMIT) ?? null;
		const request = note.lastRequest?.slice(0, CREW_REQUEST_LIMIT) || null;
		const unchanged =
			existing &&
			existing.state === note.state &&
			existing.waiting_on === note.waitingOn &&
			existing.pr_url === note.prUrl &&
			// A turn that showed a canvas is news even when its reply is the same.
			!note.canvas &&
			// A working note carries no reply: keep the last one shown.
			(note.state === "working" || existing.last_reply === reply) &&
			// A start note may carry no request: keep the last one.
			(!request || existing.last_request === request) &&
			existing.title === title;
		if (!unchanged) {
			this.sql.exec(
				`insert into crew(session_id,title,state,waiting_on,pr_url,last_reply,updated_at,
				 created_at,last_request,last_active_at,working_since)
				 values(?,?,?,?,?,?,?,?,?,?,?)
				 on conflict(session_id) do update set title=excluded.title,state=excluded.state,
				 waiting_on=excluded.waiting_on,pr_url=excluded.pr_url,
				 last_reply=coalesce(excluded.last_reply,crew.last_reply),
				 last_request=coalesce(excluded.last_request,crew.last_request),
				 updated_at=excluded.updated_at,last_active_at=excluded.last_active_at,
				 reminded_at=0,remind_n=0,
				 progress_at=case when excluded.state='working' and crew.state='working' then crew.progress_at else 0 end,
				 working_since=case when excluded.state='working'
				  then coalesce(case when crew.state='working' then crew.working_since end,excluded.working_since)
				  else null end`,
				note.sessionId,
				title,
				note.state,
				note.waitingOn,
				note.prUrl,
				note.state === "working" ? null : reply,
				now,
				now,
				request,
				now,
				note.state === "working" ? now : null,
			);
		}
		// A turn that just settled teaches the thread's usual duration.
		if (
			!unchanged &&
			existing?.state === "working" &&
			existing.working_since &&
			note.state !== "working"
		)
			this.sql.exec(
				"update crew set typical_work_ms=? where session_id=?",
				nextTypicalWorkMs(
					existing.typical_work_ms,
					now - existing.working_since,
				),
				note.sessionId,
			);
		const wake = this.wakeRow();
		const stale =
			wake.user_id !== note.userId ||
			wake.y2_session_id !== (note.ySquaredId ?? wake.y2_session_id);
		const hasY2 = Boolean(note.ySquaredId || wake.y2_session_id);
		// A turn that began with a message Y² did not send is the person's own:
		// Y² is told at its next wake, and woken for it at most every ten
		// minutes per thread. Its own sends were marked before they were made.
		let startedWake = false;
		if (note.state === "working" && existing?.state !== "working") {
			const byY2 = this.takeY2Sent(note.sessionId, !existing, now);
			if (!byY2 && request) {
				startedWake =
					now - (existing?.start_wake_at ?? 0) >= CREW_STARTED_WAKE_EVERY_MS;
				this.addEvent(
					{ kind: startedWake ? "started" : "direct", title, detail: request },
					note.sessionId,
					now,
				);
				if (startedWake)
					this.sql.exec(
						"update crew set start_wake_at=? where session_id=?",
						now,
						note.sessionId,
					);
			}
		}
		const settled = !unchanged && crewNoteMatters(note.state);
		if (settled)
			this.addEvent(
				{
					kind: note.state,
					title,
					detail:
						[
							note.state === "waiting"
								? note.waitingOn
								: note.prUrl
									? `pull request ${note.prUrl}`
									: null,
							// One line from titles and revisions the thread already held.
							note.canvas,
						]
							.filter(Boolean)
							.join("; ") || null,
				},
				note.sessionId,
				now,
			);
		const matters = settled || startedWake;
		if (stale || matters) {
			this.sql.exec(
				"update wake_state set user_id=?,y2_session_id=coalesce(?,y2_session_id) where id=1",
				note.userId,
				note.ySquaredId,
			);
		}
		if (matters && hasY2) {
			const due = crewWakeDueAt(
				wake.last_wake_at,
				now,
				crewWakeDelayMs(settled ? note.state : "started"),
			);
			this.sql.exec(
				"update wake_state set pending=1,pending_due_at=? where id=1",
				wake.pending === 1 && wake.pending_due_at !== null
					? Math.min(wake.pending_due_at, due)
					: due,
			);
		}
		const alarmAt = hasY2 ? this.rearm(now) : null;
		if (now - wake.pruned_at >= PRUNE_EVERY_MS) this.prune(now);
		return { alarmAt };
	}

	/** Remembers a change for the next wake's message (a thread's latest of each kind). */
	private addEvent(event: CrewWakeEvent, sessionId: string, now: number) {
		this.sql.exec(
			"delete from wake_events where session_id=? and kind=?",
			sessionId,
			event.kind,
		);
		this.sql.exec(
			"insert into wake_events(kind,session_id,title,detail,at) values(?,?,?,?,?)",
			event.kind,
			sessionId,
			event.title,
			event.detail,
			now,
		);
		this.sql.exec(
			"delete from wake_events where id <= (select max(id) from wake_events) - ?",
			CREW_EVENT_LIMIT,
		);
	}

	/**
	 * Y² is about to send into a thread (an existing one by id, or a new one
	 * with null), so that thread's turn start is not taken for the person's.
	 * Made before the send, so it is always there when the start note comes.
	 */
	noteY2Sent(sessionId: string | null, now: number) {
		this.sql.exec(
			"insert into y2_sent(session_id,at) values(?,?)",
			sessionId ?? "",
			now,
		);
		this.sql.exec("delete from y2_sent where at<?", now - CREW_Y2_SENT_TTL_MS);
	}

	private takeY2Sent(sessionId: string, isNew: boolean, now: number) {
		this.sql.exec("delete from y2_sent where at<?", now - CREW_Y2_SENT_TTL_MS);
		const find = (id: string) =>
			this.sql
				.exec<{ id: number }>(
					"select id from y2_sent where session_id=? order by id limit 1",
					id,
				)
				.toArray()[0];
		const mark = find(sessionId) ?? (isNew ? find("") : undefined);
		if (!mark) return false;
		this.sql.exec("delete from y2_sent where id=?", mark.id);
		return true;
	}

	private workingRows(now: number) {
		return this.sql
			.exec<{ title: string; working_since: number }>(
				"select title,working_since from crew where state='working' and working_since is not null order by working_since",
			)
			.toArray()
			.filter((row) => row.working_since <= now);
	}

	private heartbeatDue(now: number, wake: WakeRow) {
		return heartbeatDueAt({
			workingSince: this.workingRows(now).map((row) => row.working_since),
			lastWakeAt: wake.last_wake_at,
			lastHeartbeatAt: wake.last_heartbeat_at,
			now,
		});
	}

	/**
	 * The one alarm: the pending wake's due time or the next heartbeat,
	 * whichever is sooner. Returns the time to set it for, null when none is
	 * needed (nothing pending, nothing working) or one as early is set.
	 */
	private rearm(now: number, skipProactive = false): number | null {
		const wake = this.wakeRow();
		const due = [
			wake.pending === 1 ? wake.pending_due_at : null,
			this.heartbeatDue(now, wake),
			...(skipProactive ? [] : this.proactiveDueTimes(now, wake)),
		].filter((at): at is number => at !== null);
		if (!due.length) return null;
		const at = Math.min(...due);
		if (wake.alarm_at !== null && wake.alarm_at <= at) return null;
		this.sql.exec("update wake_state set alarm_at=? where id=1", at);
		return at;
	}

	/** The alarm slot's proactive candidates: the earliest active schedule and the earliest stall signal (never before a failed send's hold). */
	private proactiveDueTimes(now: number, wake: WakeRow): number[] {
		const times: number[] = [];
		const schedule = this.sql
			.exec<{ at: number | null }>(
				"select min(next_due_at) as at from schedules where status='active'",
			)
			.toArray()[0]?.at;
		if (schedule !== null && schedule !== undefined) times.push(schedule);
		if (wake.stall_nudges === 1)
			for (const row of this.stallRows()) {
				const at = stallDueAt(row, now);
				if (at !== null) times.push(at);
			}
		return times.map((at) => Math.max(at, wake.proactive_hold_until));
	}

	private stallRows(): StallRow[] {
		return this.sql
			.exec<{
				session_id: string;
				title: string;
				state: string;
				working_since: number | null;
				updated_at: number;
				typical_work_ms: number;
				stall_nudged_for: number;
				reminded_at: number;
				remind_n: number;
				progress_at: number;
			}>(
				"select session_id,title,state,working_since,updated_at,typical_work_ms,stall_nudged_for,reminded_at,remind_n,progress_at from crew where state in ('working','waiting','failed')",
			)
			.toArray()
			.map((row) => ({
				sessionId: row.session_id,
				title: row.title,
				state: row.state as StallRow["state"],
				workingSince: row.working_since,
				updatedAt: row.updated_at,
				typicalWorkMs: row.typical_work_ms,
				stallNudgedFor: row.stall_nudged_for,
				remindedAt: row.reminded_at,
				remindCount: row.remind_n,
				progressAt: row.progress_at,
			}));
	}

	/**
	 * Working threads whose stall clock ran out, to check against their turns'
	 * real progress before Y² is told they may be stuck (stall signals came from
	 * the start note alone, so a long tool call or a Claude run on a box read as
	 * stuck). Rows past the 6-hour mark are included: those never get a signal,
	 * and the check settles the ones whose settle note was lost.
	 */
	progressChecks(now: number, limit = 20): string[] {
		if (this.wakeRow().stall_nudges !== 1) return [];
		return this.stallRows()
			.filter(
				(row) =>
					row.state === "working" &&
					row.workingSince !== null &&
					row.stallNudgedFor !== row.workingSince &&
					now - stallClockFrom(row) >= stallAfterMs(row.typicalWorkMs),
			)
			.slice(0, limit)
			.map((row) => row.sessionId);
	}

	/**
	 * What the checked threads' turns really did. A running turn that renewed
	 * its lease or wrote progress moves its stall clock to then; one waiting
	 * in the queue is not stuck either. A thread with no queued or running
	 * turn lost its settle note: its row settles now (finished, or failed as
	 * the chat says) and Y² hears that instead of "it may be stuck". A thread
	 * that no longer exists is dropped. Runs at the alarm, before `takeWake`,
	 * which then decides the signals and the next alarm from these rows.
	 */
	applyProgress(
		checked: readonly string[],
		facts: readonly {
			readonly sessionId: string;
			readonly active: boolean;
			readonly queued: boolean;
			readonly progressAt: number | null;
			readonly turnStatus: string | null;
		}[],
		now: number,
	): void {
		const bySession = new Map(facts.map((fact) => [fact.sessionId, fact]));
		const wake = this.wakeRow();
		for (const sessionId of checked) {
			const fact = bySession.get(sessionId);
			if (!fact) {
				this.sql.exec("delete from crew where session_id=?", sessionId);
				continue;
			}
			// Running (or a turn this crew cannot see, such as a chat the
			// Postgres row still calls running): progress, or now while queued.
			if (fact.active || fact.turnStatus === "running") {
				const at =
					fact.queued || fact.progressAt === null
						? now
						: Math.min(now, fact.progressAt);
				this.sql.exec(
					"update crew set progress_at=max(progress_at,?) where session_id=? and state='working'",
					at,
					sessionId,
				);
				continue;
			}
			const row = this.thread(sessionId);
			if (row?.state !== "working" || !wake.user_id) continue;
			this.noteThread(
				{
					sessionId,
					title: row.title,
					state: fact.turnStatus === "failed" ? "failed" : "finished",
					waitingOn: null,
					prUrl: row.prUrl,
					lastReply: null,
					userId: wake.user_id,
					projectId: "",
					ySquaredId: wake.y2_session_id,
				},
				now,
			);
		}
	}

	/** After a wake went out the alarm may need to move to the next schedule or signal. */
	rearmAfterSend(now: number) {
		return this.rearm(now);
	}

	// ------------------------------------------------------------- settings

	settings(): YSquaredSettings {
		const row = this.wakeRow();
		return { stallNudges: row.stall_nudges === 1, timezone: row.timezone };
	}

	saveSettings(patch: Partial<YSquaredSettings>, now: number) {
		if (patch.stallNudges !== undefined)
			this.sql.exec(
				"update wake_state set stall_nudges=? where id=1",
				patch.stallNudges ? 1 : 0,
			);
		if (patch.timezone !== undefined)
			this.sql.exec(
				"update wake_state set timezone=? where id=1",
				patch.timezone,
			);
		return { settings: this.settings(), alarmAt: this.rearm(now) };
	}

	// ------------------------------------------------------------ schedules

	private scheduleView(row: ScheduleRow): ScheduleView {
		return {
			id: row.id,
			prompt: row.prompt,
			spec: JSON.parse(row.spec) as ScheduleSpec,
			timezone: row.tz,
			status: row.status as ScheduleStatus,
			nextDueAt: row.status === "active" ? row.next_due_at : null,
			lastRunAt: row.last_run_at,
		};
	}

	/** The active schedules, soonest first. */
	schedules(): ScheduleView[] {
		return this.sql
			.exec<ScheduleRow>(
				"select * from schedules where status='active' order by next_due_at",
			)
			.toArray()
			.map((row) => this.scheduleView(row));
	}

	/** Proactive status for the settings and the schedule tool. */
	proactiveStatus(now: number) {
		const row = this.wakeRow();
		return {
			settings: this.settings(),
			schedules: this.schedules(),
			proactiveToday:
				now - row.proactive_day_start >= Y_SQUARED_DAY_MS
					? 0
					: row.proactive_today,
			proactiveLimit: Y_SQUARED_PROACTIVE_WAKES_PER_DAY,
		};
	}

	createSchedule(
		draft: ScheduleDraft,
		target: { userId: string; ySquaredId: string },
		now: number,
	):
		| { ok: true; schedule: ScheduleView; alarmAt: number | null }
		| { ok: false; error: string } {
		const active = this.sql
			.exec<{ n: number }>(
				"select count(*) as n from schedules where status='active'",
			)
			.toArray()[0]?.n;
		if ((active ?? 0) >= Y_SQUARED_SCHEDULE_LIMIT)
			return {
				ok: false,
				error: `This project already has ${Y_SQUARED_SCHEDULE_LIMIT} active schedules. Cancel one first.`,
			};
		const id = crypto.randomUUID().slice(0, 8);
		this.sql.exec(
			`insert into schedules(id,prompt,spec,tz,status,next_due_at,created_at)
			 values(?,?,?,?,'active',?,?)`,
			id,
			draft.prompt,
			JSON.stringify(draft.spec),
			draft.timezone,
			draft.nextDueAt,
			now,
		);
		// Who the wake goes to: the schedule is made inside Y²'s own turn.
		this.sql.exec(
			"update wake_state set user_id=?,y2_session_id=? where id=1",
			target.userId,
			target.ySquaredId,
		);
		const created = this.sql
			.exec<ScheduleRow>("select * from schedules where id=?", id)
			.toArray()[0] as ScheduleRow;
		return {
			ok: true,
			schedule: this.scheduleView(created),
			alarmAt: this.rearm(now),
		};
	}

	cancelSchedule(id: string) {
		const before = this.sql
			.exec<{ n: number }>(
				"select count(*) as n from schedules where id=? and status='active'",
				id,
			)
			.toArray()[0]?.n;
		this.sql.exec(
			"update schedules set status='cancelled',next_due_at=null where id=? and status='active'",
			id,
		);
		return (before ?? 0) > 0;
	}

	/** One-time check-ins long overdue (the project was unreachable) are dropped, not fired late. */
	private settleMissed(now: number) {
		this.sql.exec(
			"update schedules set status='missed' where status='active' and next_due_at is not null and next_due_at<? and spec=?",
			now - Y_SQUARED_ONCE_MISSED_AFTER_MS,
			JSON.stringify({ kind: "once" }),
		);
	}

	/** Due schedules and stall signals; empty while a failed send holds them back. */
	private dueProactive(now: number, wake: WakeRow) {
		if (now < wake.proactive_hold_until)
			return { schedules: [] as ScheduleRow[], signals: [] as StallSignal[] };
		return {
			schedules: this.sql
				.exec<ScheduleRow>(
					"select * from schedules where status='active' and next_due_at<=? order by next_due_at",
					now,
				)
				.toArray(),
			signals:
				wake.stall_nudges === 1 ? stallSignals(this.stallRows(), now) : [],
		};
	}

	/** A wake carrying these went out (or was skipped by the daily cap): they are not due again. */
	private consumeProactive(items: DeliveredProactive, now: number) {
		for (const id of items.scheduleIds) {
			const row = this.sql
				.exec<ScheduleRow>("select * from schedules where id=?", id)
				.toArray()[0];
			if (row?.status !== "active") continue;
			const spec = JSON.parse(row.spec) as ScheduleSpec;
			const next = nextDueAt(spec, row.tz, now);
			if (next === null)
				this.sql.exec(
					"update schedules set status='done',next_due_at=null,last_run_at=? where id=?",
					now,
					id,
				);
			else
				this.sql.exec(
					"update schedules set next_due_at=?,last_run_at=? where id=?",
					next,
					now,
					id,
				);
		}
		for (const signal of items.signals)
			if (signal.kind === "stalled")
				this.sql.exec(
					"update crew set stall_nudged_for=? where session_id=?",
					signal.workingSince,
					signal.sessionId,
				);
			else
				this.sql.exec(
					"update crew set reminded_at=?,remind_n=remind_n+1 where session_id=?",
					now,
					signal.sessionId,
				);
	}

	/** Drops threads untouched for 30 days. */
	prune(now: number) {
		this.sql.exec(
			"delete from schedules where status<>'active' and coalesce(last_run_at,created_at)<?",
			now - Y_SQUARED_SCHEDULE_KEEP_MS,
		);
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
				last_request: string | null;
				updated_at: number;
				created_at: number;
				last_active_at: number;
				working_since: number | null;
			}>(
				`select * from crew order by
				 case state when 'waiting' then 0 when 'failed' then 0 when 'working' then 1 else 2 end,
				 last_active_at desc, updated_at desc limit ?`,
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
				`insert or ignore into crew(session_id,title,state,waiting_on,pr_url,last_reply,updated_at,
				 created_at,last_request,last_active_at,working_since)
				 values(?,?,?,?,?,?,?,?,?,?,?)`,
				row.sessionId,
				row.title,
				row.state,
				row.waitingOn,
				row.prUrl,
				row.lastReply?.slice(0, CREW_REPLY_LIMIT) ?? null,
				row.updatedAt,
				row.createdAt,
				row.lastRequest?.slice(0, CREW_REQUEST_LIMIT) ?? null,
				row.lastActiveAt || row.updatedAt,
				row.state === "working" ? (row.workingSince ?? row.updatedAt) : null,
			);
		this.sql.exec("update wake_state set reconciled=1 where id=1");
		return true;
	}

	/**
	 * The alarm fired. Sends one wake when a wake is pending and due, or a
	 * heartbeat is (a thread working long with no wake since); otherwise only
	 * re-arms. A send carries the changes since the last wake and who is
	 * still working: `body` is the message, `eventsUpTo` what to clear with
	 * `wakeSent` once it was enqueued.
	 */
	takeWake(now: number) {
		this.settleMissed(now);
		const state = this.wakeState();
		const row = this.wakeRow();
		const beat = this.heartbeatDue(now, row);
		const pendingDue = state.pending && now >= (row.pending_due_at ?? 0);
		const heartbeatDue = beat !== null && now >= beat;
		const baseDue = pendingDue || heartbeatDue;
		const proactive = this.dueProactive(now, row);
		const hasProactive =
			proactive.schedules.length > 0 || proactive.signals.length > 0;
		// A due wake with no change to tell and nothing proactive is only a
		// "still working" heartbeat: the model could answer nothing but
		// NOTHING_TO_REPORT (212 of 389 production wakes in 3 days), so it
		// costs a model turn for no message. Skip it; the heartbeat clock moves
		// on and the stall signals (proactive) still wake Y².
		if (
			baseDue &&
			!hasProactive &&
			this.sql
				.exec<{ n: number }>("select count(*) n from wake_events")
				.toArray()[0]?.n === 0
		) {
			this.sql.exec(
				"update wake_state set pending=0,pending_due_at=null,last_heartbeat_at=case when ? then ? else last_heartbeat_at end where id=1",
				heartbeatDue ? 1 : 0,
				now,
			);
			this.saveWake({ ...state, pending: false, alarmAt: null });
			return {
				action: "none" as const,
				next: { ...state, pending: false, alarmAt: null },
				rearmAt: this.rearm(now),
			};
		}
		if (!baseDue && !hasProactive) {
			// An early or stale alarm: nothing to send; set the next one.
			this.saveWake({ ...state, alarmAt: null });
			return {
				action: "none" as const,
				next: { ...state, alarmAt: null },
				rearmAt: this.rearm(now),
			};
		}
		let next: WakeState = { ...state, alarmAt: null, lastWakeAt: now };
		if (baseDue) {
			const decided = decideWake({ ...state, pending: true }, now);
			if (decided.action === "capped") {
				// A heartbeat held by the cap is not a pending wake. Due
				// schedules and signals wait for the window too.
				this.saveWake({
					...decided.next,
					pending: state.pending,
					alarmAt: decided.retryAt ?? null,
				});
				return {
					...decided,
					action: "capped" as const,
					rearmAt: null as number | null,
				};
			}
			next = decided.next;
		}
		// Schedules, stall nudges and reminders count against their own daily
		// cap, so the hourly one of event wakes is never starved by them.
		let delivered = NO_PROACTIVE;
		let counted = false;
		if (hasProactive) {
			const items: DeliveredProactive = {
				scheduleIds: proactive.schedules.map((item) => item.id),
				signals: proactive.signals,
			};
			const cap = decideProactive(
				{
					dayStart: row.proactive_day_start,
					count: row.proactive_today,
				},
				now,
			);
			this.sql.exec(
				"update wake_state set proactive_day_start=?,proactive_today=? where id=1",
				cap.next.dayStart,
				cap.next.count,
			);
			if (cap.allowed) {
				delivered = items;
				counted = true;
			} else this.consumeProactive(items, now); // skipped for today, not replayed
		}
		if (!baseDue && !counted) {
			this.saveWake({ ...state, alarmAt: null });
			return {
				action: "none" as const,
				next: { ...state, alarmAt: null },
				rearmAt: this.rearm(now),
			};
		}
		this.saveWake(next);
		if (baseDue)
			this.sql.exec(
				"update wake_state set pending_due_at=null,last_heartbeat_at=case when ? then ? else last_heartbeat_at end where id=1",
				heartbeatDue ? 1 : 0,
				now,
			);
		const events = this.sql
			.exec<{
				id: number;
				kind: string;
				title: string;
				detail: string | null;
			}>("select id,kind,title,detail from wake_events order by id")
			.toArray();
		const body = crewWakeBody({
			events: events.map((event) => ({
				kind: event.kind as CrewWakeEvent["kind"],
				title: event.title,
				detail: event.detail,
			})),
			working: this.workingRows(now).map((thread) => ({
				title: thread.title,
				since: thread.working_since,
			})),
			now,
			proactive: proactiveWakeLines({
				signals: delivered.signals,
				schedules: proactive.schedules
					.filter((item) => delivered.scheduleIds.includes(item.id))
					.map((item) => ({ id: item.id, prompt: item.prompt })),
			}),
		});
		return {
			action: "send" as const,
			next,
			body,
			eventsUpTo: events.at(-1)?.id ?? 0,
			// What this wake carries is not due again once it is enqueued
			// (rearmAfterSend then moves the alarm to the next one).
			rearmAt: this.rearm(now, true),
			delivered,
			counted,
		};
	}

	/** The wake was enqueued: its changes are told, forget them; due schedules and signals it carried move on. */
	wakeSent(
		eventsUpTo: number,
		delivered: DeliveredProactive = NO_PROACTIVE,
		now = Date.now(),
	) {
		this.sql.exec("delete from wake_events where id<=?", eventsUpTo);
		this.sql.exec("update wake_state set wake_failures=0 where id=1");
		this.consumeProactive(delivered, now);
	}

	/**
	 * The wake could not be enqueued (a database hiccup, Y²'s chat not
	 * readable): it stays pending with its changes, due again after a growing
	 * wait, and the alarm is re-armed for it. Returns when to retry, null once
	 * it has failed too often (the next note re-arms it). A wake that carried
	 * schedules or signals gives its daily-cap slot back and holds them until
	 * the retry.
	 */
	returnWake(now: number, hadProactive = false): { retryAt: number | null } {
		const state = this.wakeState();
		const failures = this.wakeRow().wake_failures + 1;
		const retryAt = now + wakeRetryDelayMs(failures);
		this.saveWake({
			...state,
			pending: true,
			wakesThisHour: Math.max(0, state.wakesThisHour - 1),
			alarmAt: null,
		});
		this.sql.exec(
			"update wake_state set wake_failures=?,pending_due_at=? where id=1",
			failures,
			retryAt,
		);
		if (hadProactive)
			this.sql.exec(
				"update wake_state set proactive_today=max(0,proactive_today-1),proactive_hold_until=? where id=1",
				retryAt,
			);
		if (failures >= CREW_WAKE_RETRIES) return { retryAt: null };
		return { retryAt: this.rearm(now) ?? retryAt };
	}
}

function toRow(row: {
	session_id: string;
	title: string;
	state: string;
	waiting_on: string | null;
	pr_url: string | null;
	last_reply: string | null;
	last_request: string | null;
	updated_at: number;
	created_at: number;
	last_active_at: number;
	working_since?: number | null;
}): CrewRow {
	return {
		sessionId: row.session_id,
		title: row.title,
		state: row.state as CrewState,
		waitingOn: row.waiting_on,
		prUrl: row.pr_url,
		lastReply: row.last_reply,
		lastRequest: row.last_request,
		updatedAt: row.updated_at,
		createdAt: row.created_at,
		lastActiveAt: row.last_active_at || row.updated_at,
		workingSince: row.state === "working" ? (row.working_since ?? null) : null,
	};
}
