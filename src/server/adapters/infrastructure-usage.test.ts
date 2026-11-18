import type { PoolClient } from "pg";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	UsageCeilingReached,
	UsageWindowExhausted,
	usageWindowMs,
} from "#/domain/infrastructure-usage";
import { usageNotice } from "#/domain/usage-warning";
import {
	assertUsageWindowsOpen,
	reserveInfrastructureUsage,
	userInfrastructureUsage,
} from "./infrastructure-usage";

/**
 * An in-memory stand-in for the usage tables, answering the adapter's
 * statements by what they do (now() is the fake clock), so a test sees the
 * windows a real database would.
 */
type Reservation = {
	id: string;
	userId: string;
	reserved: number;
	consumed: number | null;
	created: number;
	settled: number | null;
};
type Window = { start: number; carried: number | null; waived: number | null };
type State = {
	autoReset: boolean;
	windows: Record<string, Window>;
	reservations: Reservation[];
	adjustments: unknown[][];
	otherFleetMicroUsd: number;
	runningTurn: boolean;
};

const USER = "owner";
const hour = 3_600_000;
const now = Date.parse("2026-11-14T12:00:00Z");
let state: State;
let snapshot: State | null = null;

function startWindows() {
	for (const id of ["five_hour", "weekly"] as const) {
		const window = state.windows[id];
		if (!window || window.start + usageWindowMs(id) <= Date.now())
			state.windows[id] = { start: Date.now(), carried: null, waived: null };
	}
}

const text = (value: number | null | undefined) =>
	value === null || value === undefined ? null : String(value);

async function query(sql: string, params: unknown[] = []) {
	const at = Date.now();
	if (sql === "begin") {
		snapshot = structuredClone(state);
		return { rows: [] };
	}
	if (sql === "commit") {
		snapshot = null;
		return { rows: [] };
	}
	if (sql === "rollback") {
		if (snapshot) state = snapshot;
		snapshot = null;
		return { rows: [] };
	}
	if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
	if (sql.includes("left join infrastructure_usage_window w5")) {
		const since = params[1] as number;
		const [w5, ww] = [state.windows.five_hour, state.windows.weekly];
		const policy = {
			five_hour: null,
			weekly: null,
			auto_reset: state.autoReset,
			five_hour_start: text(w5?.start),
			five_hour_carried: text(w5?.carried),
			five_hour_waived: text(w5?.waived),
			weekly_start: text(ww?.start),
			weekly_carried: text(ww?.carried),
			weekly_waived: text(ww?.waived),
		};
		const charges = state.reservations.filter(
			(r) =>
				r.userId === params[0] &&
				(r.consumed === null || (r.settled ?? 0) > since),
		);
		const amount = (r: Reservation) => r.consumed ?? r.reserved;
		const sum = (list: Reservation[]) =>
			String(list.reduce((total, r) => total + amount(r), 0));
		const open = (r: Reservation) => r.consumed === null;
		const sums = (id: string, start: number | undefined) => ({
			[`${id}_open`]: sum(charges.filter(open)),
			[`${id}_open_or_since`]: sum(
				charges.filter(
					(r) => open(r) || (start !== undefined && r.created >= start),
				),
			),
			[`${id}_since`]: sum(
				charges.filter((r) => start !== undefined && r.created >= start),
			),
			[`${id}_held_before`]: sum(
				charges.filter(
					(r) =>
						start !== undefined &&
						r.created < start &&
						(open(r) || (r.settled ?? -1) >= start),
				),
			),
		});
		return {
			rows: [
				{
					...policy,
					settled_total: sum(charges.filter((r) => !open(r))),
					...sums("five_hour", w5?.start),
					...sums("weekly", ww?.start),
				},
			],
		};
	}
	if (sql.includes("exists(select 1 from auth_user")) {
		const existing = state.reservations.find((r) => r.id === params[2]);
		const fleet =
			state.otherFleetMicroUsd +
			state.reservations.reduce(
				(sum, r) => sum + (r.consumed ?? r.reserved),
				0,
			);
		return {
			rows: [
				{
					existing_user_id: existing?.userId ?? null,
					resource_key: existing ? "vm:test" : null,
					reserved_micro_usd: text(existing?.reserved),
					consumed_micro_usd: text(existing?.consumed),
					owner: params[0] === USER,
					fleet: String(fleet),
					lifetime: String(fleet),
				},
			],
		};
	}
	if (sql.includes("from api_turn"))
		return { rows: state.runningTurn ? [{}] : [] };
	if (sql.includes("with carried as")) {
		const carried = state.reservations
			.filter(
				(r) =>
					r.userId === params[0] &&
					r.created < at &&
					(r.consumed === null || (r.settled ?? 0) >= at),
			)
			.reduce((sum, r) => sum + (r.consumed ?? r.reserved), 0);
		state.windows[params[1] as string] = {
			start: at,
			carried,
			waived: params[2] as number | null,
		};
		return { rows: [] };
	}
	if (sql.startsWith("insert into infrastructure_usage_adjustment")) {
		state.adjustments.push(params);
		return { rows: [] };
	}
	if (sql.includes("insert into infrastructure_usage_reservation")) {
		startWindows();
		state.reservations.push({
			id: params[0] as string,
			userId: params[1] as string,
			reserved: params[4] as number,
			consumed: null,
			created: at,
			settled: null,
		});
		return { rows: [] };
	}
	if (sql.includes("update infrastructure_usage_reservation set reserved")) {
		startWindows();
		const hold = state.reservations.find((r) => r.id === params[0]);
		if (hold) hold.reserved = params[1] as number;
		return { rows: [] };
	}
	throw new Error(`Unexpected statement: ${sql}`);
}

const client = { query, release: () => {} } as unknown as PoolClient;
vi.mock("./database", () => ({
	database: () => ({ connect: async () => client, query: client.query }),
}));

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(now);
	vi.stubEnv("YTIMESY_USER_5H_MICRO_USD", "5000000");
	vi.stubEnv("YTIMESY_USER_WEEKLY_MICRO_USD", "25000000");
	vi.stubEnv("YTIMESY_FLEET_MONTHLY_MICRO_USD", "500000000");
	vi.stubEnv("YTIMESY_FLEET_LIFETIME_MICRO_USD", "7000000000");
	vi.spyOn(console, "info").mockImplementation(() => {});
	snapshot = null;
	// The 5-hour window started 2 hours ago and $5 of it has settled: it is
	// exhausted until 15:00 UTC. The weekly window holds the same $5.
	state = {
		autoReset: false,
		windows: {
			five_hour: { start: now - 2 * hour, carried: null, waived: null },
			weekly: { start: now - 2 * hour, carried: null, waived: null },
		},
		reservations: [
			{
				id: "old",
				userId: USER,
				reserved: 6_000_000,
				consumed: 5_000_000,
				created: now - 2 * hour,
				settled: now - hour,
			},
		],
		adjustments: [],
		otherFleetMicroUsd: 0,
		runningTurn: false,
	};
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

const create = (amountMicroUsd: number, id = crypto.randomUUID()) =>
	reserveInfrastructureUsage(
		{
			id,
			userId: USER,
			resourceKey: "vm:test",
			amountMicroUsd,
			hourlyMicroUsd: 1_000_000,
		},
		client,
	);

it("still refuses a normal user's new work at an exhausted window, and resets nothing", async () => {
	await expect(assertUsageWindowsOpen(USER, client)).rejects.toBeInstanceOf(
		UsageWindowExhausted,
	);
	await expect(create(100_000)).rejects.toBeInstanceOf(UsageWindowExhausted);
	expect(state.adjustments).toEqual([]);
	expect(state.windows.five_hour.start).toBe(now - 2 * hour);
	expect(state.windows.five_hour.carried).toBeNull();
});

it("resets an auto-reset user's exhausted window instead, audits it, and admits the work", async () => {
	state.autoReset = true;
	const before = await userInfrastructureUsage(USER, client);
	// Up to the limit it looks exactly like anyone else's.
	expect(usageNotice(before)?.level).toBe("exhausted");
	await expect(assertUsageWindowsOpen(USER, client)).resolves.toBeUndefined();
	expect(state.windows.five_hour).toEqual({
		start: now,
		carried: 0,
		waived: now + 3 * hour,
	});
	// The weekly window was not exhausted, so it keeps counting.
	expect(state.windows.weekly.start).toBe(now - 2 * hour);
	expect(state.adjustments).toEqual([
		[
			expect.any(String),
			"system",
			USER,
			"2026-11-01",
			5_000_000,
			"auto-reset policy",
		],
	]);
	const after = await userInfrastructureUsage(USER, client);
	expect(after.windows[0]).toMatchObject({
		id: "five_hour",
		usedMicroUsd: 0,
		exhausted: false,
		resetsAt: now + 5 * hour,
	});
	expect(after.windows[1].usedMicroUsd).toBe(5_000_000);
	expect(after.autoResets).toEqual([
		{ id: "five_hour", resetAt: now, normalResetsAt: now + 3 * hour },
	]);
	expect(usageNotice(after)?.message).toContain(
		"Your account resets automatically, so it has been reset",
	);
});

it("resets at a new machine's admission too, and keeps counting the auto-reset user's usage", async () => {
	state.autoReset = true;
	await expect(create(1_000_000)).resolves.toBe(1_000_000);
	expect(state.adjustments).toHaveLength(1);
	const usage = await userInfrastructureUsage(USER, client);
	expect(usage.windows.map((window) => window.usedMicroUsd)).toEqual([
		1_000_000, 6_000_000,
	]);
	// Past 80% of the new window the ordinary warning comes back.
	vi.setSystemTime(now + 60_000);
	await create(3_100_000);
	expect(
		usageNotice(await userInfrastructureUsage(USER, client)),
	).toMatchObject({ level: "warning", window: "five_hour", usedPercent: 82 });
	expect(state.adjustments).toHaveLength(1);
});

it("warns an auto-reset user at 80% without resetting anything", async () => {
	state.autoReset = true;
	state.reservations[0].consumed = 4_100_000;
	await expect(assertUsageWindowsOpen(USER, client)).resolves.toBeUndefined();
	const usage = await userInfrastructureUsage(USER, client);
	expect(usageNotice(usage)).toMatchObject({
		level: "warning",
		usedPercent: 82,
	});
	expect(state.adjustments).toEqual([]);
	expect(usage.autoResets).toEqual([]);
});

it("lets a running machine past the ceiling continue by resetting, counting only what it adds", async () => {
	// A machine has run in a fresh window and holds $5.50 against a $6
	// ceiling (limit plus an hour of its $1/hour).
	state.reservations = [
		{
			id: "running",
			userId: USER,
			reserved: 5_500_000,
			consumed: null,
			created: now - hour,
			settled: null,
		},
	];
	state.windows.five_hour = { start: now - hour, carried: null, waived: null };
	const grow = () =>
		reserveInfrastructureUsage(
			{
				id: "running",
				userId: USER,
				resourceKey: "vm:test",
				amountMicroUsd: 7_000_000,
				hourlyMicroUsd: 1_000_000,
				minimumMicroUsd: 7_000_000,
			},
			client,
			"increase",
		);
	await expect(grow()).rejects.toBeInstanceOf(UsageCeilingReached);
	state.autoReset = true;
	await expect(grow()).resolves.toBe(7_000_000);
	expect(state.windows.five_hour.carried).toBe(5_500_000);
	const usage = await userInfrastructureUsage(USER, client);
	// The weekly window was under its ceiling: it still counts the whole hold.
	expect(usage.windows.map((window) => window.usedMicroUsd)).toEqual([
		1_500_000, 7_000_000,
	]);
});

it("never bypasses the fleet cap: the work is refused and the reset rolled back", async () => {
	state.autoReset = true;
	state.otherFleetMicroUsd = 499_500_000;
	await expect(create(1_000_000)).rejects.toThrow(
		"The fleet cloud execution budget is exhausted.",
	);
	expect(state.adjustments).toEqual([]);
	expect(state.windows.five_hour).toEqual({
		start: now - 2 * hour,
		carried: null,
		waived: null,
	});
});
