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
	const earlier = days.filter((entry) => entry.day !== day).slice(-6);
	if (earlier.length) {
		lines.push("", "Previous days (total / user-visible):");
		for (const entry of earlier)
			lines.push(`  ${entry.day}  ${entry.total} / ${entry.userVisible}`);
	}
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
