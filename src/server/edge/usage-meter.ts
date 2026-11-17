import {
	type BudgetUsage,
	budgetAppliesTo,
	budgetDayKey,
	cloudflareBudgetUsers,
	EMPTY_USAGE,
} from "../../domain/cloudflare-budget";

/**
 * The user to meter, or null: metering is opt-in (YTIMESY_CF_BUDGET_USERS,
 * docs/cloudflare-budget.md). With no one listed `identity` is not even
 * called, so an unlisted chat costs no SQL; an unlisted user is never
 * metered, rolled up or budgeted.
 */
export function meteredUserId(
	users: string | undefined,
	identity: () => string | null,
): string | null {
	const listed = cloudflareBudgetUsers(users);
	if (!listed.size) return null;
	const userId = identity();
	return budgetAppliesTo(listed, userId) ? userId : null;
}

/** A chat flushes its totals to the user's hub at most this often, plus at a turn's end. */
export const USAGE_ROLLUP_INTERVAL_MS = 3 * 60_000;
/** Counts that arrive outside an alarm step are written once this many are pending. */
const PENDING_WRITE_THRESHOLD = 50;

export type UsageDelta = Pick<
	BudgetUsage,
	"wallMs" | "requests" | "wsMsgs" | "alarms"
>;
const zero = (): UsageDelta => ({
	wallMs: 0,
	requests: 0,
	wsMsgs: 0,
	alarms: 0,
});

/**
 * One Durable Object's compute usage per UTC day (`usage_day`), kept in
 * memory and written as ONE row update per step end. Metering never fails or
 * slows an action: every method swallows its errors (logged once per kind).
 */
export class UsageMeter {
	private pending: UsageDelta = zero();
	private pendingCount = 0;
	private lastRollupAt = 0;
	private ready = false;
	constructor(
		private readonly sql: SqlStorage,
		private readonly userId: () => string | null,
		private readonly now: () => number = Date.now,
	) {}

	private guard<T>(what: string, run: () => T, fallback: T): T {
		try {
			return run();
		} catch (error) {
			console.warn("Usage metering skipped.", {
				what,
				cause: error instanceof Error ? error.name : "unknown",
			});
			return fallback;
		}
	}

	private ensureTable() {
		if (this.ready) return;
		this.sql.exec(`create table if not exists usage_day(
			day text not null, user_id text not null,
			wall_ms integer not null default 0, requests integer not null default 0,
			ws_msgs integer not null default 0, alarms integer not null default 0,
			sent_wall_ms integer not null default 0, sent_requests integer not null default 0,
			sent_ws_msgs integer not null default 0, sent_alarms integer not null default 0,
			primary key(day,user_id))`);
		this.ready = true;
	}

	/** Adds to the in-memory counters; writes only when many are pending. */
	record(delta: Partial<UsageDelta>) {
		this.pending.wallMs += Math.max(0, Math.round(delta.wallMs ?? 0));
		this.pending.requests += delta.requests ?? 0;
		this.pending.wsMsgs += delta.wsMsgs ?? 0;
		this.pending.alarms += delta.alarms ?? 0;
		this.pendingCount += (delta.requests ?? 0) + (delta.wsMsgs ?? 0);
		if (this.pendingCount >= PENDING_WRITE_THRESHOLD) this.flush();
	}

	/** Times `run` and adds its wall time and one alarm; the step end's single write follows. */
	async timeStep<T>(run: () => Promise<T>, alarms = 1): Promise<T> {
		const started = this.now();
		try {
			return await run();
		} finally {
			this.record({ wallMs: this.now() - started, alarms });
			this.flush();
		}
	}

	/** One upsert of everything pending into today's row. */
	flush() {
		const userId = this.userId();
		if (!userId) return;
		const delta = this.pending;
		if (!delta.wallMs && !delta.requests && !delta.wsMsgs && !delta.alarms)
			return;
		this.guard(
			"flush",
			() => {
				this.ensureTable();
				this.sql.exec(
					`insert into usage_day(day,user_id,wall_ms,requests,ws_msgs,alarms) values(?,?,?,?,?,?)
					 on conflict(day,user_id) do update set wall_ms=wall_ms+excluded.wall_ms,
					 requests=requests+excluded.requests,ws_msgs=ws_msgs+excluded.ws_msgs,alarms=alarms+excluded.alarms`,
					budgetDayKey(this.now()),
					userId,
					delta.wallMs,
					delta.requests,
					delta.wsMsgs,
					delta.alarms,
				);
				this.pending = zero();
				this.pendingCount = 0;
			},
			undefined,
		);
	}

	/** What has not reached the user's hub yet, per day. */
	unsent() {
		return this.guard(
			"unsent",
			() => {
				this.ensureTable();
				return this.sql
					.exec<{ day: string } & UsageDelta>(
						`select day,wall_ms as wallMs,requests,ws_msgs as wsMsgs,alarms from usage_day
						 where wall_ms>sent_wall_ms or requests>sent_requests or ws_msgs>sent_ws_msgs or alarms>sent_alarms`,
					)
					.toArray();
			},
			[] as ({ day: string } & UsageDelta)[],
		);
	}

	private markSent(day: string, sent: UsageDelta) {
		this.sql.exec(
			`update usage_day set sent_wall_ms=?,sent_requests=?,sent_ws_msgs=?,sent_alarms=? where day=?`,
			sent.wallMs,
			sent.requests,
			sent.wsMsgs,
			sent.alarms,
			day,
		);
	}

	/**
	 * Sends the unsent totals (as deltas) to the hub: at most once per
	 * interval, or at once when `force` (a turn's end). Never throws.
	 */
	async rollup(
		send: (delta: UsageDelta) => Promise<unknown>,
		force = false,
	): Promise<void> {
		try {
			const now = this.now();
			if (!force && now - this.lastRollupAt < USAGE_ROLLUP_INTERVAL_MS) return;
			// Not metered (see meteredUserId): nothing was written, nothing to send.
			if (!this.userId()) return;
			this.flush();
			const rows = this.unsent();
			if (!rows.length) return;
			this.lastRollupAt = now;
			for (const row of rows) {
				const rowDelta = this.sql
					.exec<UsageDelta>(
						`select sent_wall_ms as wallMs,sent_requests as requests,sent_ws_msgs as wsMsgs,sent_alarms as alarms
						 from usage_day where day=?`,
						row.day,
					)
					.toArray()[0];
				const sent = rowDelta ?? zero();
				await send({
					wallMs: row.wallMs - sent.wallMs,
					requests: row.requests - sent.requests,
					wsMsgs: row.wsMsgs - sent.wsMsgs,
					alarms: row.alarms - sent.alarms,
				});
				this.markSent(row.day, row);
			}
		} catch (error) {
			console.warn("Usage was not rolled up to the user hub.", {
				cause: error instanceof Error ? error.name : "unknown",
			});
		}
	}

	/** Today's row, for tests and diagnostics. */
	today(): BudgetUsage {
		const userId = this.userId();
		if (!userId) return EMPTY_USAGE;
		return this.guard(
			"today",
			() => {
				this.ensureTable();
				const row = this.sql
					.exec<UsageDelta>(
						"select wall_ms as wallMs,requests,ws_msgs as wsMsgs,alarms from usage_day where day=? and user_id=?",
						budgetDayKey(this.now()),
						userId,
					)
					.toArray()[0];
				return row ?? EMPTY_USAGE;
			},
			EMPTY_USAGE,
		);
	}
}
