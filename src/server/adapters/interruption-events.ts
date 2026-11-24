import {
	type InterruptionEvent,
	type InterruptionRow,
	interruptionRateLimited,
} from "#/domain/interruption-report";
import { sessionItemsFromUnknown } from "#/domain/session-item";
import { database } from "./database";

/** A write that is not done by then is left behind: the action goes on. */
const WRITE_TIMEOUT_MS = 1500;
const lastRecorded = new Map<string, number>();
const MAX_REMEMBERED = 500;

/**
 * Records one interruption, best effort. Never throws and never waits long:
 * bookkeeping must not fail or slow the action it describes (AGENTS.md).
 * At most one row per kind and turn per INTERRUPTION_RATE_LIMIT_MS, checked
 * in memory first (no query) and then in the insert itself, so a crash
 * loop writes a bounded number of rows. "limited" means an earlier row for
 * this kind and turn stands; "failed" means nothing is known to be written.
 */
export async function recordInterruption(
	event: InterruptionEvent,
	deps: {
		query?: (
			sql: string,
			values: unknown[],
		) => Promise<{ rowCount?: number | null }>;
		now?: () => number;
		timeoutMs?: number;
	} = {},
): Promise<"recorded" | "limited" | "failed"> {
	try {
		const now = (deps.now ?? Date.now)();
		const key = `${event.kind}:${event.turnId ?? event.sessionId ?? "-"}`;
		if (interruptionRateLimited(lastRecorded.get(key), now)) return "limited";
		if (lastRecorded.size >= MAX_REMEMBERED) lastRecorded.clear();
		lastRecorded.set(key, now);
		const query =
			deps.query ?? ((sql, values) => database().query(sql, values));
		const write = query(
			`insert into interruption_event(kind,turn_id,session_id,cause,recovered,user_visible)
			 select $1,$2,$3,$4,$5,$6
			 where $2::text is null or not exists (
			   select 1 from interruption_event where kind=$1 and turn_id=$2 and at > now() - interval '10 minutes')`,
			[
				event.kind.slice(0, 60),
				event.turnId?.slice(0, 100) ?? null,
				event.sessionId?.slice(0, 100) ?? null,
				(event.cause ?? "unknown").slice(0, 120),
				event.recovered ?? false,
				event.userVisible ?? false,
			],
		);
		write.catch(() => undefined);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const result = await Promise.race([
			write,
			new Promise<null>((resolve) => {
				timer = setTimeout(
					() => resolve(null),
					deps.timeoutMs ?? WRITE_TIMEOUT_MS,
				);
			}),
		]).finally(() => clearTimeout(timer));
		if (!result) return "failed";
		return (result.rowCount ?? 1) > 0 ? "recorded" : "limited";
	} catch {
		console.warn("Interruption not recorded.", { kind: event.kind });
		return "failed";
	}
}

/** Test hook: forget what the limiter remembers. */
export function resetInterruptionLimiter() {
	lastRecorded.clear();
}

export async function interruptionRowsSince(days: number) {
	const result = await database().query<InterruptionRow>(
		"select at,kind,cause,recovered,user_visible from interruption_event where at >= now() - $1::int * interval '1 day' order by at",
		[days],
	);
	return result.rows;
}

export async function pruneInterruptionHistory(keepDays = 35) {
	await database().query(
		"delete from interruption_event where at < now() - $1::int * interval '1 day'",
		[keepDays],
	);
	await database().query(
		"delete from canary_run where at < now() - $1::int * interval '1 day'",
		[keepDays],
	);
}

export type CanaryRun = {
	readonly id: string;
	readonly at: Date;
	readonly sessionId: string;
	readonly nonce: string;
	readonly baselineItems: number;
};

export async function startCanaryRun(run: {
	sessionId: string;
	nonce: string;
	baselineItems: number;
}) {
	await database().query(
		"insert into canary_run(session_id,nonce,baseline_items) values($1,$2,$3)",
		[run.sessionId, run.nonce, run.baselineItems],
	);
}

/** The newest run still waiting for its answers (ok is null). */
export async function pendingCanaryRun(): Promise<CanaryRun | null> {
	const result = await database().query<{
		id: string;
		at: Date;
		session_id: string;
		nonce: string;
		baseline_items: number;
	}>(
		"select id,at,session_id,nonce,baseline_items from canary_run where ok is null order by at desc limit 1",
	);
	const row = result.rows[0];
	return row
		? {
				id: row.id,
				at: new Date(row.at),
				sessionId: row.session_id,
				nonce: row.nonce,
				baselineItems: row.baseline_items,
			}
		: null;
}

export async function finishCanaryRun(id: string, failure: string | null) {
	await database().query(
		"update canary_run set ok=$2,checked_at=now(),failure=$3 where id=$1",
		[id, failure === null, failure?.slice(0, 500) ?? null],
	);
}

/** The chat the canary keeps reusing, so each run wakes it instead of creating one. */
export async function lastCanarySession() {
	const result = await database().query<{ session_id: string }>(
		"select session_id from canary_run where session_id is not null order by at desc limit 1",
	);
	return result.rows[0]?.session_id ?? null;
}

/** The chat's items, for the canary to check (null when the chat is gone). */
export async function canarySessionItems(userId: string, sessionId: string) {
	const result = await database().query<{ items: unknown }>(
		"select items from agent_session where id=$1 and user_id=$2",
		[sessionId, userId],
	);
	return result.rows[0] ? sessionItemsFromUnknown(result.rows[0].items) : null;
}

export async function canaryCountsSince(days: number) {
	const result = await database().query<{ runs: string; failures: string }>(
		"select count(*) as runs, count(*) filter (where ok is false) as failures from canary_run where at >= now() - $1::int * interval '1 day'",
		[days],
	);
	return {
		runs: Number(result.rows[0]?.runs ?? 0),
		failures: Number(result.rows[0]?.failures ?? 0),
	};
}
