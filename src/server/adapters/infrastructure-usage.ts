import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
	blockingUsageWindow,
	USAGE_WINDOWS,
	type UsageAutoReset,
	UsageCeilingReached,
	type UsageCharge,
	UsageWindowExhausted,
	type UsageWindowState,
	usageWindowCeiling,
	usageWindowMs,
	usageWindowState,
	utcUsageMonth,
	validUsageAmount,
} from "#/domain/infrastructure-usage";
import { requireInfrastructureAdmin } from "../auth/infrastructure-admin";
import { database } from "./database";
import { sessionSlugFamily } from "./freestyle/slug-sql";

type BudgetLimits = {
	fiveHourMicroUsd: number;
	weeklyMicroUsd: number;
	fleetMicroUsd: number;
	lifetimeFleetMicroUsd: number;
};

/**
 * Every limit is a deployment setting (scripts/deploy-*.ts supply the
 * defaults, $5 per 5 hours and $25 per week); a metered process without one
 * refuses VM work rather than running unmetered.
 */
function infrastructureUsageLimits(): BudgetLimits {
	const read = (name: string) => {
		const value = process.env[name];
		if (!value?.trim()) throw new Error(`${name} must be configured.`);
		return validUsageAmount(Number(value));
	};
	return {
		fiveHourMicroUsd: read("YTIMESY_USER_5H_MICRO_USD"),
		weeklyMicroUsd: read("YTIMESY_USER_WEEKLY_MICRO_USD"),
		fleetMicroUsd: read("YTIMESY_FLEET_MONTHLY_MICRO_USD"),
		lifetimeFleetMicroUsd: read("YTIMESY_FLEET_LIFETIME_MICRO_USD"),
	};
}

const WEEK_MS = USAGE_WINDOWS[USAGE_WINDOWS.length - 1].ms;

/**
 * A user's usage windows: each runs from its start in
 * infrastructure_usage_window to a fixed reset, counting reservations dated
 * when their hold started (settled ones of the last week, open holds
 * whatever their age); a per-user override in infrastructure_usage_policy
 * replaces a deployment limit. `autoReset` is the user's auto-reset policy;
 * `autoResets` lists the windows it restarted that an ordinary user would
 * still be waiting for, for the one-time notice.
 */
async function readWindows(
	client: Pick<PoolClient, "query">,
	userId: string,
	limits: BudgetLimits,
	now = Date.now(),
) {
	const result = await client.query<{
		amount: string | null;
		open: boolean | null;
		at: string | null;
		settled: string | null;
		five_hour: string | null;
		weekly: string | null;
		auto_reset: boolean | null;
		five_hour_start: string | null;
		five_hour_carried: string | null;
		five_hour_waived: string | null;
		weekly_start: string | null;
		weekly_carried: string | null;
		weekly_waived: string | null;
	}>(
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
	const number = (value: string | null | undefined) =>
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
	const limit = (override: string | null | undefined, fallback: number) =>
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

/**
 * The user's 5-hour and weekly windows (used, limit, percent, reset time),
 * plus what the last week settled and what running machines hold now.
 */
export async function userInfrastructureUsage(
	userId: string,
	client: Pick<PoolClient, "query"> = database(),
) {
	return readWindows(client, userId, infrastructureUsageLimits());
}

/**
 * Refuses new work (a turn the user starts) once a usage window is
 * exhausted, with the time it reopens. Never called for work already
 * running, and a no-op where VM usage is not metered. A user with the
 * auto-reset policy is not refused: the exhausted windows restart now
 * (resetUsageWindows) and the work goes ahead.
 */
export async function assertUsageWindowsOpen(
	userId: string,
	client: Pick<PoolClient, "query"> = database(),
) {
	const limits = infrastructureUsageLimits();
	const usage = await readWindows(client, userId, limits);
	const blocking = blockingUsageWindow(usage.windows);
	if (!blocking) return;
	if (!usage.autoReset) throw new UsageWindowExhausted(blocking);
	// Read again under the budget lock: a concurrent admission may have
	// reset the window already.
	await usageTransaction(async (locked) => {
		const current = await readWindows(locked, userId, limits);
		await resetUsageWindows(
			locked,
			userId,
			current.windows.filter((window) => window.exhausted),
		);
	});
}

export const AUTO_RESET_ACTOR = "system";
export const AUTO_RESET_REASON = "auto-reset policy";

/**
 * The auto-reset policy's answer to a refusal, inside the caller's budget
 * transaction: each window restarts now, so earlier settled usage falls
 * outside it, and records what the user's holds open at the reset already
 * counted (carried_micro_usd) so that a running machine counts only what it
 * adds from here (usageWindowState). Each reset is audited as a
 * 'window_reset' adjustment of the usage it cleared. Rolled back with the
 * transaction when the work is refused anyway (a fleet cap).
 */
async function resetUsageWindows(
	client: Pick<PoolClient, "query">,
	userId: string,
	windows: readonly UsageWindowState[],
) {
	const period = utcUsageMonth();
	for (const window of windows) {
		await client.query(
			`with carried as (select coalesce(sum(coalesce(consumed_micro_usd,reserved_micro_usd)),0) as amount
			  from infrastructure_usage_reservation
			  where user_id=$1 and created_at<now() and (consumed_micro_usd is null or settled_at>=now()))
			 insert into infrastructure_usage_window(user_id,window_id,started_at,carried_micro_usd,waived_until)
			 select $1,$2,now(),carried.amount,to_timestamp($3::float8/1000) from carried
			 on conflict(user_id,window_id) do update set started_at=excluded.started_at,
			  carried_micro_usd=excluded.carried_micro_usd,waived_until=excluded.waived_until`,
			[userId, window.id, window.resetsAt],
		);
		await client.query(
			"insert into infrastructure_usage_adjustment(id,actor_id,user_id,kind,period,amount_micro_usd,reason) values($1,$2,$3,'window_reset',$4,$5,$6)",
			[
				randomUUID(),
				AUTO_RESET_ACTOR,
				userId,
				period,
				window.usedMicroUsd,
				AUTO_RESET_REASON,
			],
		);
		console.info("Usage window auto-reset.", {
			window: window.id,
			clearedMicroUsd: window.usedMicroUsd,
		});
	}
}

/**
 * The fleet's spend as `fleet` (the month `period` names, plus holds still
 * open from earlier months) and `lifetime`, from the running totals in
 * infrastructure_usage_total (one row per month, kept by a trigger on
 * infrastructure_usage_reservation).
 */
const FLEET_TOTALS_SQL = (period: string) =>
	`(select coalesce(sum(case when period=${period}::date then charged_micro_usd else open_micro_usd end),0)
	  from infrastructure_usage_total) as fleet,
	 (select coalesce(sum(charged_micro_usd),0) from infrastructure_usage_total) as lifetime`;

/**
 * The fleet's monthly and lifetime spend (consumed plus held) against its
 * caps, for the owner's budget alerts. Null when the caps are not configured.
 */
export async function fleetInfrastructureUsage() {
	let limits: BudgetLimits;
	try {
		limits = infrastructureUsageLimits();
	} catch {
		return null;
	}
	const period = utcUsageMonth();
	const result = await database().query<{ fleet: string; lifetime: string }>(
		`select ${FLEET_TOTALS_SQL("$1")}`,
		[period],
	);
	return {
		period,
		monthlyUsedMicroUsd: Number(result.rows[0]?.fleet ?? 0),
		monthlyCapMicroUsd: limits.fleetMicroUsd,
		lifetimeUsedMicroUsd: Number(result.rows[0]?.lifetime ?? 0),
		lifetimeCapMicroUsd: limits.lifetimeFleetMicroUsd,
	};
}

/** Short transactions serialize budget admission across every worker replica. No provider calls hold this lock. */
async function usageTransaction<T>(
	operation: (client: PoolClient) => Promise<T>,
	existingClient?: PoolClient,
) {
	const client = existingClient ?? (await database().connect());
	try {
		await client.query("begin");
		await client.query("select pg_advisory_xact_lock(81738420)");
		const result = await operation(client);
		await client.query("commit");
		return result;
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		if (!existingClient) client.release();
	}
}

/**
 * Usage after a window has reset starts the next one: its reset time is
 * fixed then and does not move. Prefixed (as a CTE) to the statement that
 * writes the reservation; now() is the transaction's time, the same as the
 * reservation's created_at, so that usage counts in the new window.
 * Parameters from $first: user id, then each window's length in ms.
 */
function startWindows(first: number) {
	const [user, fiveHour, weekly] = [first, first + 1, first + 2].map(
		(n) => `$${n}`,
	);
	return `with started as (insert into infrastructure_usage_window(user_id,window_id,started_at)
	 values(${user},'five_hour',now()),(${user},'weekly',now())
	 on conflict(user_id,window_id) do update set started_at=excluded.started_at,carried_micro_usd=null,waived_until=null
	 where infrastructure_usage_window.started_at + make_interval(secs => (case infrastructure_usage_window.window_id
	  when 'five_hour' then ${fiveHour}::float8 else ${weekly}::float8 end)/1000) <= now())`;
}
const windowStartParams = (userId: string) => [
	userId,
	usageWindowMs("five_hour"),
	usageWindowMs("weekly"),
];

/**
 * Replays reuse the same reservation; an uncertain remote failure retains the
 * entire hold. Returns the hold's total as it now stands.
 */
export async function reserveInfrastructureUsage(
	input: {
		id: string;
		userId: string;
		resourceKey: string;
		amountMicroUsd: number;
		/**
		 * The machine's hourly cost: running work may carry a window about an
		 * hour of it past the limit (the hard ceiling), never further. Without
		 * it the ceiling is the limit itself.
		 */
		hourlyMicroUsd?: number;
		/**
		 * When set, a hold that would pass the ceiling shrinks to fit under it,
		 * down to this total; the caller sizes its runtime to what is returned.
		 */
		minimumMicroUsd?: number;
		/**
		 * True while the machine is already running: its hold may grow past a
		 * usage window up to the ceiling, so running work finishes. A start or
		 * a new machine is refused once a window is exhausted, unless a turn
		 * of the session this machine belongs to is still running (it was
		 * admitted before the limit).
		 */
		continuing?: boolean;
		/**
		 * The machine's previous hold, settled at its real usage first in the
		 * same transaction (as settleInfrastructureUsage would, committed only
		 * with this reservation).
		 */
		settlePrevious?: { id: string; consumedMicroUsd: number };
	},
	existingClient?: PoolClient,
	mode: "create" | "increase" = "create",
) {
	validUsageAmount(input.amountMicroUsd);
	if (
		!input.amountMicroUsd ||
		!input.resourceKey ||
		input.resourceKey.length > 200
	)
		throw new Error("Invalid infrastructure reservation.");
	const limits = infrastructureUsageLimits();
	if (input.settlePrevious)
		validUsageAmount(input.settlePrevious.consumedMicroUsd);
	return usageTransaction(async (client) => {
		if (input.settlePrevious)
			await settleHold(client, {
				...input.settlePrevious,
				userId: input.userId,
			});
		let amountToReserve = input.amountMicroUsd;
		const period = utcUsageMonth();
		// Everything the decision needs in one read under the budget lock; the
		// checks below run in their original order on it.
		const read = await client.query<{
			existing_user_id: string | null;
			resource_key: string | null;
			reserved_micro_usd: string | null;
			consumed_micro_usd: string | null;
			owner: boolean;
			fleet: string;
			lifetime: string;
		}>(
			`select e.user_id as existing_user_id,e.resource_key,e.reserved_micro_usd,e.consumed_micro_usd,
			 exists(select 1 from auth_user where id=$1) as owner,
			 ${FLEET_TOTALS_SQL("$2")}
			 from (select 1) one
			 left join infrastructure_usage_reservation e on e.id=$3`,
			[input.userId, period, input.id],
		);
		const row = read.rows[0];
		if (row.existing_user_id !== null) {
			if (
				row.existing_user_id !== input.userId ||
				row.resource_key !== input.resourceKey ||
				(mode === "create" &&
					Number(row.reserved_micro_usd) !== input.amountMicroUsd)
			)
				throw new Error("Infrastructure reservation identity changed.");
			if (row.consumed_micro_usd !== null)
				throw new Error("Infrastructure reservation is already settled.");
			if (mode === "create") return Number(row.reserved_micro_usd);
			amountToReserve = Math.max(
				0,
				input.amountMicroUsd - Number(row.reserved_micro_usd),
			);
			if (!amountToReserve) return Number(row.reserved_micro_usd);
		} else if (mode === "increase")
			throw new Error("Infrastructure reservation is unavailable.");
		if (!row.owner) throw new Error("Usage account is unavailable.");
		let { windows, autoReset } = await readWindows(
			client,
			input.userId,
			limits,
		);
		// An auto-reset user is never refused by their own windows: what would
		// refuse them restarts the windows instead (fleet caps still apply).
		const resetInstead = async (exhausted: readonly UsageWindowState[]) => {
			await resetUsageWindows(client, input.userId, exhausted);
			({ windows } = await readWindows(client, input.userId, limits));
		};
		if (!input.continuing && mode === "create") {
			const blocking = blockingUsageWindow(windows);
			if (blocking) {
				// Only the machine of a session whose turn is still running may
				// start past the limit: that turn was admitted before it.
				const running = await client.query(
					`select 1 from api_turn t where t.user_id=$1 and t.state in ('queued','running')
					 and left($2,3)='vm:' and ${sessionSlugFamily("substr($2,4)", "t.session_id")} limit 1`,
					[input.userId, input.resourceKey],
				);
				if (!running.rows.length) {
					if (!autoReset) throw new UsageWindowExhausted(blocking);
					await resetInstead(windows.filter((window) => window.exhausted));
				}
			}
		}
		// The hard ceiling holds for every hold, running machines included.
		const held = mode === "increase" ? Number(row.reserved_micro_usd) : 0;
		const overrun = input.hourlyMicroUsd ?? 0;
		const rooms = () =>
			windows
				.map((window) => ({
					window,
					room:
						usageWindowCeiling(window.limitMicroUsd, overrun) -
						window.usedMicroUsd,
				}))
				.sort((a, b) => a.room - b.room);
		const refused = (binding: { room: number } | undefined) =>
			binding !== undefined &&
			amountToReserve > binding.room &&
			(input.minimumMicroUsd === undefined ||
				held + binding.room < input.minimumMicroUsd ||
				binding.room <= 0);
		if (autoReset && refused(rooms()[0]))
			await resetInstead(
				rooms()
					.filter(({ room }) => amountToReserve > room)
					.map(({ window }) => window),
			);
		const [binding] = rooms();
		if (binding && amountToReserve > binding.room) {
			if (refused(binding)) throw new UsageCeilingReached(binding.window);
			amountToReserve = binding.room;
		}
		const total = held + amountToReserve;
		// Holds survive month boundaries until settled: an old run cannot evade the new fleet cap.
		if (Number(row.fleet) + amountToReserve > limits.fleetMicroUsd)
			throw new Error("The fleet cloud execution budget is exhausted.");
		if (Number(row.lifetime) + amountToReserve > limits.lifetimeFleetMicroUsd)
			throw new Error(
				"The lifetime fleet cloud execution budget is exhausted.",
			);
		if (mode === "increase") {
			await client.query(
				`${startWindows(3)} update infrastructure_usage_reservation set reserved_micro_usd=$2 where id=$1`,
				[input.id, total, ...windowStartParams(input.userId)],
			);
			return total;
		}
		await client.query(
			`${startWindows(6)} insert into infrastructure_usage_reservation(id,user_id,resource_key,period,reserved_micro_usd) values($1,$2,$3,$4,$5)`,
			[
				input.id,
				input.userId,
				input.resourceKey,
				period,
				total,
				...windowStartParams(input.userId),
			],
		);
		return total;
	}, existingClient);
}

/** Only a trusted provider reconciliation may settle a hold; the browser cannot refund itself. */
export async function settleInfrastructureUsage(
	input: {
		id: string;
		userId: string;
		consumedMicroUsd: number;
	},
	existingClient?: PoolClient,
) {
	validUsageAmount(input.consumedMicroUsd);
	await usageTransaction((client) => settleHold(client, input), existingClient);
}

/** Settles a hold inside the caller's budget transaction; a refusal throws (and rolls it back). */
async function settleHold(
	client: PoolClient,
	input: { id: string; userId: string; consumedMicroUsd: number },
) {
	// Settling never blocks a machine: a hold settles once, at most at what
	// it reserved. Usage past the hold (a VM that ran past its cap) settles at
	// the hold and is logged; a second, different settlement keeps the first
	// and is logged. Throwing here once left a chat unable to wake its VM.
	const result = await client.query<{
		reserved_micro_usd: string;
		consumed_micro_usd: string | null;
	}>(
		`with hold as (select reserved_micro_usd,consumed_micro_usd from infrastructure_usage_reservation where id=$1 and user_id=$2),
		 settled as (update infrastructure_usage_reservation set consumed_micro_usd=least($3,reserved_micro_usd),settled_at=now()
		  where id=$1 and user_id=$2 and consumed_micro_usd is null returning 1)
		 select reserved_micro_usd,consumed_micro_usd from hold`,
		[input.id, input.userId, input.consumedMicroUsd],
	);
	const row = result.rows[0];
	if (!row) throw new Error("Infrastructure settlement has no reservation.");
	const reserved = Number(row.reserved_micro_usd);
	if (row.consumed_micro_usd !== null) {
		if (Number(row.consumed_micro_usd) !== input.consumedMicroUsd)
			console.warn("Infrastructure hold was already settled; kept the first.", {
				reservationId: input.id,
				settledMicroUsd: Number(row.consumed_micro_usd),
				laterMicroUsd: input.consumedMicroUsd,
			});
		return;
	}
	if (input.consumedMicroUsd > reserved)
		console.warn(
			"Infrastructure usage exceeded its hold; settled at the hold.",
			{
				reservationId: input.id,
				reservedMicroUsd: reserved,
				measuredMicroUsd: input.consumedMicroUsd,
			},
		);
}

/** Kinds an admin may set now: a per-user override of one usage window's limit. */
export const USAGE_LIMIT_ADJUSTMENTS = {
	five_hour_limit: "five_hour_micro_usd",
	weekly_limit: "weekly_micro_usd",
} as const;
export type UsageLimitAdjustment = keyof typeof USAGE_LIMIT_ADJUSTMENTS;

export async function adjustInfrastructureAllowance(input: {
	id: string;
	actorId: string;
	userId: string;
	kind: UsageLimitAdjustment;
	amountMicroUsd: number;
	reason: string;
}) {
	requireInfrastructureAdmin(input.actorId);
	validUsageAmount(input.amountMicroUsd);
	const reason = input.reason.trim();
	if (!reason || reason.length > 500)
		throw new Error("A concise grant reason is required.");
	if (!Object.hasOwn(USAGE_LIMIT_ADJUSTMENTS, input.kind))
		throw new Error("Invalid allowance adjustment.");
	const column = USAGE_LIMIT_ADJUSTMENTS[input.kind];
	await usageTransaction(async (client) => {
		const old = await client.query<{
			actor_id: string;
			user_id: string;
			kind: string;
			amount_micro_usd: string;
			reason: string;
		}>(
			"select actor_id,user_id,kind,amount_micro_usd,reason from infrastructure_usage_adjustment where id=$1",
			[input.id],
		);
		if (old.rows[0]) {
			const row = old.rows[0];
			if (
				row.actor_id !== input.actorId ||
				row.user_id !== input.userId ||
				row.kind !== input.kind ||
				Number(row.amount_micro_usd) !== input.amountMicroUsd ||
				row.reason !== reason
			)
				throw new Error("Allowance adjustment identity changed.");
			return;
		}
		const owner = await client.query("select id from auth_user where id=$1", [
			input.userId,
		]);
		if (!owner.rows.length) throw new Error("Usage account is unavailable.");
		const period = utcUsageMonth();
		await client.query(
			`insert into infrastructure_usage_policy(user_id,${column}) values($1,$2) on conflict(user_id) do update set ${column}=excluded.${column}`,
			[input.userId, input.amountMicroUsd],
		);
		await client.query(
			"insert into infrastructure_usage_adjustment(id,actor_id,user_id,kind,period,amount_micro_usd,reason) values($1,$2,$3,$4,$5,$6,$7)",
			[
				input.id,
				input.actorId,
				input.userId,
				input.kind,
				period,
				input.amountMicroUsd,
				reason,
			],
		);
	});
}
