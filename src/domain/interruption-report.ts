/** Pure reporting over interruption_event rows (docs/interruption-monitoring.md). */

export type InterruptionEvent = {
	/** turn.interrupted, lease-takeover, turn-abandoned, queued_message.restored, delayed-start, ... */
	readonly kind: string;
	readonly turnId?: string | null;
	readonly sessionId?: string | null;
	readonly cause?: string;
	/** The turn went on (resumed, requeued, restored). */
	readonly recovered?: boolean;
	/** The user saw an error or a stall. */
	readonly userVisible?: boolean;
};

export type InterruptionRow = {
	readonly at: Date | string;
	readonly kind: string;
	readonly cause: string;
	readonly recovered: boolean;
	readonly user_visible: boolean;
	/** Short hash of the chat id (never the id itself). */
	readonly chat?: string | null;
};

/** Causes with a shipped fix: the digest says so, so a repeat is a regression. Add an entry with the fix. */
export const FIXED_INTERRUPTION_CAUSES: Readonly<Record<string, string>> = {
	"turn-abandoned/lease-expired":
		"stopped turns settle quietly when their executor dies; 2026-11-26",
	"lease-takeover/box-heartbeat-lost":
		"renewal requests time out and retry; 2026-11-26",
	"delayed-start/no-box-took-turn":
		"moves to the chat's object after 45 s; 2026-11-24",
};

export type InterruptionDay = {
	/** UTC day, e.g. 2026-11-24. */
	readonly day: string;
	readonly total: number;
	readonly userVisible: number;
	readonly recovered: number;
	readonly byKind: Readonly<Record<string, number>>;
	/** Keyed "kind/cause". */
	readonly byCause: Readonly<Record<string, number>>;
};

/** Target: user-visible machine start failures per 1,000 turns (2026-11-26). */
export const MACHINE_FAILURE_TARGET_PER_1000 = 1;
/** Kind of the interruption_event a user saw as a failed machine start. */
export const MACHINE_START_FAILED_KIND = "machine-start-failed";

export function machineFailureRatePer1000(failures: number, turns: number) {
	return turns > 0 ? (failures / turns) * 1000 : 0;
}

export function machineFailureRateExceeded(failures: number, turns: number) {
	return (
		machineFailureRatePer1000(failures, turns) > MACHINE_FAILURE_TARGET_PER_1000
	);
}

/** The canary runs every 30 minutes; silence this long means it stopped or was unconfigured. */
export const CANARY_STALE_MS = 90 * 60_000;
const CANARY_RECENT_MS = 24 * 3_600_000;

/**
 * Why the canary monitor itself is not working, or null. Silent for a canary
 * that never ran (not set up yet) or stopped long ago (switched off on purpose).
 */
export function canaryWatchdogProblem(input: {
	readonly configured: boolean;
	readonly lastRunAt: Date | null;
	readonly now: Date;
}): string | null {
	if (!input.lastRunAt) return null;
	const silentMs = input.now.getTime() - input.lastRunAt.getTime();
	if (!input.configured)
		return silentMs < CANARY_RECENT_MS
			? "The canary is not configured any more (its canary_config row or YTIMESY_CANARY_* variables are gone) but it ran within the last day: a reset, cleanup or migration may have removed it."
			: null;
	return silentMs > CANARY_STALE_MS
		? `The canary has not run for 90 minutes (last run ${Math.round(silentMs / 60_000)} minutes ago).`
		: null;
}

/** One row per event; at most one per kind and turn inside this window is kept. */
export const INTERRUPTION_RATE_LIMIT_MS = 10 * 60_000;

/** The UTC day of an instant. */
export function utcDay(at: Date | string) {
	return new Date(at).toISOString().slice(0, 10);
}

/** Daily counts for each UTC day that has rows, oldest first. */
export function dailyInterruptionReport(
	rows: readonly InterruptionRow[],
): InterruptionDay[] {
	const days = new Map<
		string,
		{
			total: number;
			userVisible: number;
			recovered: number;
			byKind: Record<string, number>;
			byCause: Record<string, number>;
		}
	>();
	for (const row of rows) {
		const day = utcDay(row.at);
		const entry = days.get(day) ?? {
			total: 0,
			userVisible: 0,
			recovered: 0,
			byKind: {},
			byCause: {},
		};
		entry.total += 1;
		if (row.user_visible) entry.userVisible += 1;
		if (row.recovered) entry.recovered += 1;
		entry.byKind[row.kind] = (entry.byKind[row.kind] ?? 0) + 1;
		const key = `${row.kind}/${row.cause}`;
		entry.byCause[key] = (entry.byCause[key] ?? 0) + 1;
		days.set(day, entry);
	}
	return [...days.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([day, entry]) => ({ day, ...entry }));
}

/** The digest email body for one day (a missing day reads as zero). */
export function interruptionDigestText(
	days: readonly InterruptionDay[],
	day: string,
	canary?: { readonly runs: number; readonly failures: number },
	/** The day's rows (with chat hashes) for the top-causes list. */
	rows: readonly InterruptionRow[] = [],
	machine?: { readonly turns: number; readonly machineFailures: number },
) {
	const found = days.find((entry) => entry.day === day);
	const lines = [
		`Interruptions on ${day} (UTC): ${found?.total ?? 0}, user-visible: ${found?.userVisible ?? 0}, recovered: ${found?.recovered ?? 0}.`,
	];
	const sorted = (counts: Readonly<Record<string, number>>) =>
		Object.entries(counts).sort(
			([a, x], [b, y]) => y - x || a.localeCompare(b),
		);
	if (found) {
		lines.push("", "By kind/cause:");
		for (const [key, count] of sorted(found.byCause))
			lines.push(`  ${count}  ${key}`);
	}
	const top = topCauses(rows, day);
	if (top.length) {
		lines.push("", "Top causes:");
		for (const cause of top)
			lines.push(
				`  ${cause.count}  ${cause.key}  chats ${cause.chats.join(", ")}  ${cause.fix ? `fixed (${cause.fix})` : "not fixed"}`,
			);
	}
	const earlier = days.filter((entry) => entry.day !== day).slice(-6);
	if (earlier.length) {
		lines.push("", "Previous days (total / user-visible):");
		for (const entry of earlier)
			lines.push(`  ${entry.day}  ${entry.total} / ${entry.userVisible}`);
	}
	if (machine)
		lines.push(
			"",
			`Machine start failures seen by users: ${machine.machineFailures} of ${machine.turns} turns (${machineFailureRatePer1000(machine.machineFailures, machine.turns).toFixed(2)} per 1,000; target under ${MACHINE_FAILURE_TARGET_PER_1000})${machineFailureRateExceeded(machine.machineFailures, machine.turns) ? " ABOVE target" : ""}.`,
		);
	if (canary)
		lines.push("", `Canary: ${canary.runs} runs, ${canary.failures} failed.`);
	return lines.join("\n");
}

/** Whether a recorded event of this kind and turn, `lastAt` ms ago-stamped, still suppresses a new row. */
export function interruptionRateLimited(
	lastAt: number | undefined,
	now: number,
	windowMs = INTERRUPTION_RATE_LIMIT_MS,
) {
	return lastAt !== undefined && now - lastAt < windowMs;
}

function topCauses(rows: readonly InterruptionRow[], day: string, limit = 5) {
	const groups = new Map<string, { count: number; chats: Set<string> }>();
	for (const row of rows) {
		if (utcDay(row.at) !== day) continue;
		const key = `${row.kind}/${row.cause}`;
		const group = groups.get(key) ?? { count: 0, chats: new Set<string>() };
		group.count += 1;
		if (row.chat) group.chats.add(row.chat);
		groups.set(key, group);
	}
	return [...groups.entries()]
		.sort(([a, x], [b, y]) => y.count - x.count || a.localeCompare(b))
		.slice(0, limit)
		.map(([key, group]) => ({
			key,
			count: group.count,
			chats: [...group.chats].slice(0, 5),
			fix: FIXED_INTERRUPTION_CAUSES[key],
		}));
}
