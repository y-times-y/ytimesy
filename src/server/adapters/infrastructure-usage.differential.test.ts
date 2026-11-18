import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	USAGE_WINDOWS,
	type UsageAutoReset,
	type UsageCharge,
	usageWindowState,
} from "#/domain/infrastructure-usage";
import { readWindows } from "./infrastructure-usage";

/**
 * The window read used to return every reservation of the week (hundreds of
 * rows per call) and sum them in JS. It now returns one row. This runs the
 * old query and JS (kept below as the reference) and the new read on
 * randomized reservation sets in a real Postgres (PGlite) and asserts equal
 * results.
 */
const WEEK_MS = USAGE_WINDOWS[USAGE_WINDOWS.length - 1].ms;
const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-14T12:00:00.123Z");
const LIMITS = {
	fiveHourMicroUsd: 5_000_000,
	weeklyMicroUsd: 25_000_000,
	fleetMicroUsd: 1e12,
	lifetimeFleetMicroUsd: 1e12,
};

async function referenceReadWindows(
	client: PGlite,
	userId: string,
	limits: typeof LIMITS,
	now: number,
) {
	const result = await client.query<Record<string, string | boolean | null>>(
		`select coalesce(r.consumed_micro_usd,r.reserved_micro_usd) as amount,
		 r.consumed_micro_usd is null as open,
		 (extract(epoch from r.created_at)*1000)::float8 as at,
		 (extract(epoch from r.settled_at)*1000)::float8 as settled,
		 p.five_hour_micro_usd as five_hour,p.weekly_micro_usd as weekly,p.auto_reset,
		 (extract(epoch from w5.started_at)*1000)::float8 as five_hour_start,w5.carried_micro_usd as five_hour_carried,
		 (extract(epoch from w5.waived_until)*1000)::float8 as five_hour_waived,
		 (extract(epoch from ww.started_at)*1000)::float8 as weekly_start,ww.carried_micro_usd as weekly_carried,
		 (extract(epoch from ww.waived_until)*1000)::float8 as weekly_waived
		 from (select 1) one
		 left join infrastructure_usage_policy p on p.user_id=$1
		 left join infrastructure_usage_window w5 on w5.user_id=$1 and w5.window_id='five_hour'
		 left join infrastructure_usage_window ww on ww.user_id=$1 and ww.window_id='weekly'
		 left join infrastructure_usage_reservation r on r.user_id=$1
		  and (r.consumed_micro_usd is null or r.settled_at > to_timestamp($2::float8/1000))`,
		[userId, now - WEEK_MS],
	);
	const number = (value: unknown) =>
		value === null || value === undefined ? null : Number(value);
	const charges: UsageCharge[] = result.rows
		.filter((row) => row.amount !== null)
		.map((row) => ({
			at: Number(row.at),
			microUsd: Number(row.amount),
			open: row.open === true,
			settledAt: number(row.settled),
		}));
	const policy = result.rows[0];
	const limit = (override: unknown, fallback: number) =>
		override === null || override === undefined ? fallback : Number(override);
	const rows = [
		{
			id: "five_hour" as const,
			limit: limit(policy?.five_hour, limits.fiveHourMicroUsd),
			start: number(policy?.five_hour_start),
			carried: number(policy?.five_hour_carried),
			waived: number(policy?.five_hour_waived),
		},
		{
			id: "weekly" as const,
			limit: limit(policy?.weekly, limits.weeklyMicroUsd),
			start: number(policy?.weekly_start),
			carried: number(policy?.weekly_carried),
			waived: number(policy?.weekly_waived),
		},
	];
	const windows = rows.map((row) =>
		usageWindowState(row.id, charges, row.limit, row.start, now, row.carried),
	);
	const autoResets: UsageAutoReset[] = rows.flatMap((row, index) =>
		row.carried !== null &&
		row.start !== null &&
		windows[index].resetsAt !== null &&
		(row.waived === null || row.waived > now)
			? [{ id: row.id, resetAt: row.start, normalResetsAt: row.waived }]
			: [],
	);
	return {
		windows,
		autoReset: policy?.auto_reset === true,
		autoResets,
		consumedMicroUsd: charges
			.filter((charge) => !charge.open)
			.reduce((sum, charge) => sum + charge.microUsd, 0),
		reservedMicroUsd: charges
			.filter((charge) => charge.open)
			.reduce((sum, charge) => sum + charge.microUsd, 0),
	};
}

// A small seeded generator so a failure reproduces.
function rng(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

let db: PGlite;
beforeAll(async () => {
	db = new PGlite();
	await db.exec(`
		create table infrastructure_usage_policy (user_id text primary key,
		 five_hour_micro_usd bigint, weekly_micro_usd bigint, auto_reset boolean not null default false);
		create table infrastructure_usage_window (user_id text not null, window_id text not null,
		 started_at timestamptz not null, carried_micro_usd bigint, waived_until timestamptz,
		 primary key(user_id,window_id));
		create table infrastructure_usage_reservation (id uuid primary key default gen_random_uuid(),
		 user_id text not null, resource_key text not null default 'vm:x',
		 reserved_micro_usd bigint not null, consumed_micro_usd bigint,
		 created_at timestamptz not null, settled_at timestamptz);`);
});
afterAll(() => db.close());

const iso = (ms: number) => new Date(ms).toISOString();

async function seed(random: () => number, user: string) {
	const pick = <T>(items: readonly T[]) =>
		items[Math.floor(random() * items.length)];
	const int = (max: number) => Math.floor(random() * max);
	// Window starts: none, expired, running, exactly at the boundary.
	const start = (length: number) =>
		pick([
			null,
			NOW - length - int(HOUR),
			NOW - length,
			NOW - length + 1,
			NOW - int(length),
			NOW - int(length),
			NOW,
		]);
	const starts = {
		five_hour: start(5 * HOUR),
		weekly: start(WEEK_MS),
	};
	const boundaries = [
		...Object.values(starts).filter((v): v is number => v !== null),
		NOW - WEEK_MS,
	];
	for (const id of ["five_hour", "weekly"] as const) {
		const startedAt = starts[id];
		if (startedAt === null) continue;
		const carried = pick([null, null, 0, 500_000, 2_000_000, 9_000_000]);
		const waived = carried === null ? null : pick([null, NOW - 1, NOW + HOUR]);
		await db.query(
			"insert into infrastructure_usage_window values($1,$2,$3,$4,$5)",
			[user, id, iso(startedAt), carried, waived === null ? null : iso(waived)],
		);
	}
	if (random() < 0.7)
		await db.query(
			"insert into infrastructure_usage_policy values($1,$2,$3,$4)",
			[
				user,
				pick([null, 1_000_000, 3_000_000]),
				pick([null, 10_000_000]),
				random() < 0.5,
			],
		);
	const count = int(40);
	for (let index = 0; index < count; index++) {
		const created = pick([
			NOW - int(WEEK_MS + 2 * HOUR),
			NOW - int(6 * HOUR),
			pick(boundaries) + pick([-1, 0, 1, -1000, 1000]),
		]);
		const reserved = 1 + int(3_000_000);
		const open = random() < 0.3;
		const settledAt = open
			? null
			: Math.min(
					NOW,
					pick([
						created + int(2 * HOUR),
						pick(boundaries) + pick([-1, 0, 1]),
						created,
					]),
				);
		const settled = settledAt === null ? null : Math.max(settledAt, created);
		await db.query(
			"insert into infrastructure_usage_reservation(user_id,reserved_micro_usd,consumed_micro_usd,created_at,settled_at) values($1,$2,$3,$4,$5)",
			[
				user,
				reserved,
				open ? null : int(reserved + 1),
				iso(created),
				settled === null ? null : iso(settled),
			],
		);
	}
}

it("returns what the old row-per-reservation read computed, in one row", async () => {
	for (let round = 0; round < 150; round++) {
		const random = rng(round + 1);
		const user = `user-${round}`;
		await seed(random, user);
		const expected = await referenceReadWindows(db, user, LIMITS, NOW);
		let rowCount = -1;
		const counting = {
			query: async (sql: string, params?: unknown[]) => {
				const result = await db.query(sql, params);
				rowCount = result.rows.length;
				return result as never;
			},
		};
		const actual = await readWindows(counting as never, user, LIMITS, NOW);
		expect(actual, `round ${round}`).toEqual(expected);
		expect(rowCount).toBe(1);
	}
}, 120_000);

it("a user with no rows at all reads as unused windows", async () => {
	const expected = await referenceReadWindows(db, "nobody", LIMITS, NOW);
	expect(await readWindows(db as never, "nobody", LIMITS, NOW)).toEqual(
		expected,
	);
});

it("exercises each branch of the arithmetic", async () => {
	// A carried window with holds older than its start, a boundary charge, a
	// waived reset: asserts the generator reaches carried and non-carried use.
	let carriedRunning = 0;
	let usedNonZero = 0;
	for (let round = 0; round < 150; round++) {
		const result = await readWindows(db as never, `user-${round}`, LIMITS, NOW);
		if (result.autoResets.length) carriedRunning++;
		if (result.windows.some((window) => window.usedMicroUsd > 0)) usedNonZero++;
	}
	expect(carriedRunning).toBeGreaterThan(10);
	expect(usedNonZero).toBeGreaterThan(50);
});
