import type { PoolClient } from "pg";
import {
	blockingUsageWindow,
	USAGE_WINDOWS,
	type UsageCharge,
	UsageWindowExhausted,
	usageWindowState,
	utcUsageMonth,
	validUsageAmount,
} from "#/domain/infrastructure-usage";
import { requireInfrastructureAdmin } from "../auth/infrastructure-admin";
import { database } from "./database";

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
 * A user's usage windows: settled reservations of the last week at their
 * settlement, open holds now; a per-user override in
 * infrastructure_usage_policy replaces a deployment limit.
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
		five_hour: string | null;
		weekly: string | null;
	}>(
		`select coalesce(r.consumed_micro_usd,r.reserved_micro_usd) as amount,
		 r.consumed_micro_usd is null as open,
		 (extract(epoch from coalesce(r.settled_at,r.created_at))*1000)::float8 as at,
		 p.five_hour_micro_usd as five_hour,p.weekly_micro_usd as weekly
		 from (select 1) one
		 left join infrastructure_usage_policy p on p.user_id=$1
		 left join infrastructure_usage_reservation r on r.user_id=$1
		  and (r.consumed_micro_usd is null or r.settled_at > to_timestamp($2::float8/1000))`,
		[userId, now - WEEK_MS],
	);
	const charges: UsageCharge[] = result.rows
		.filter((row) => row.amount !== null)
		.map((row) => ({
			at: Number(row.at),
			microUsd: Number(row.amount),
			open: row.open === true,
		}));
	const policy = result.rows[0];
	const limit = (override: string | null | undefined, fallback: number) =>
		override === null || override === undefined ? fallback : Number(override);
	const windows = [
		usageWindowState(
			"five_hour",
			charges,
			limit(policy?.five_hour, limits.fiveHourMicroUsd),
			now,
		),
		usageWindowState(
			"weekly",
			charges,
			limit(policy?.weekly, limits.weeklyMicroUsd),
			now,
		),
	];
	return {
		windows,
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
 * running, and a no-op where VM usage is not metered.
 */
export async function assertUsageWindowsOpen(
	userId: string,
	client: Pick<PoolClient, "query"> = database(),
) {
	const blocking = blockingUsageWindow(
		(await userInfrastructureUsage(userId, client)).windows,
	);
	if (blocking) throw new UsageWindowExhausted(blocking);
}

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
		`select
		 (select coalesce(sum(case when consumed_micro_usd is null then reserved_micro_usd else consumed_micro_usd end),0)
		  from infrastructure_usage_reservation where period=$1::date or consumed_micro_usd is null) as fleet,
		 (select coalesce(sum(coalesce(consumed_micro_usd,reserved_micro_usd)),0) from infrastructure_usage_reservation) as lifetime`,
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

/** Replays reuse the same reservation; an uncertain remote failure retains the entire hold. */
export async function reserveInfrastructureUsage(
	input: {
		id: string;
		userId: string;
		resourceKey: string;
		amountMicroUsd: number;
		/**
		 * True while the machine is already running: its hold may grow past a
		 * usage window, so running work finishes. A start or a new machine is
		 * refused once a window is exhausted, unless one of the user's turns
		 * is still running (it was admitted before the limit).
		 */
		continuing?: boolean;
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
	return usageTransaction(async (client) => {
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
			 (select coalesce(sum(case when consumed_micro_usd is null then reserved_micro_usd else consumed_micro_usd end),0)
			  from infrastructure_usage_reservation where period=$2::date or consumed_micro_usd is null) as fleet,
			 (select coalesce(sum(coalesce(consumed_micro_usd,reserved_micro_usd)),0) from infrastructure_usage_reservation) as lifetime
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
			if (mode === "create") return;
			amountToReserve = Math.max(
				0,
				input.amountMicroUsd - Number(row.reserved_micro_usd),
			);
			if (!amountToReserve) return;
		} else if (mode === "increase")
			throw new Error("Infrastructure reservation is unavailable.");
		if (!row.owner) throw new Error("Usage account is unavailable.");
		if (!input.continuing && mode === "create") {
			const blocking = blockingUsageWindow(
				(await readWindows(client, input.userId, limits)).windows,
			);
			if (blocking) {
				const running = await client.query(
					"select 1 from api_turn where user_id=$1 and state in ('queued','running') limit 1",
					[input.userId],
				);
				if (!running.rows.length) throw new UsageWindowExhausted(blocking);
			}
		}
		// Holds survive month boundaries until settled: an old run cannot evade the new fleet cap.
		if (Number(row.fleet) + amountToReserve > limits.fleetMicroUsd)
			throw new Error("The fleet cloud execution budget is exhausted.");
		if (Number(row.lifetime) + amountToReserve > limits.lifetimeFleetMicroUsd)
			throw new Error(
				"The lifetime fleet cloud execution budget is exhausted.",
			);
		if (mode === "increase") {
			await client.query(
				"update infrastructure_usage_reservation set reserved_micro_usd=$2 where id=$1",
				[input.id, input.amountMicroUsd],
			);
			return;
		}
		await client.query(
			"insert into infrastructure_usage_reservation(id,user_id,resource_key,period,reserved_micro_usd) values($1,$2,$3,$4,$5)",
			[input.id, input.userId, input.resourceKey, period, input.amountMicroUsd],
		);
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
	await usageTransaction(async (client) => {
		// Reads the hold and settles it in one statement; the update only
		// applies where the checks below pass, and any refusal rolls back.
		const result = await client.query<{
			reserved_micro_usd: string;
			consumed_micro_usd: string | null;
		}>(
			`with hold as (select reserved_micro_usd,consumed_micro_usd from infrastructure_usage_reservation where id=$1 and user_id=$2),
			 settled as (update infrastructure_usage_reservation set consumed_micro_usd=$3,settled_at=now()
			  where id=$1 and user_id=$2 and consumed_micro_usd is null and reserved_micro_usd>=$3 returning 1)
			 select reserved_micro_usd,consumed_micro_usd from hold`,
			[input.id, input.userId, input.consumedMicroUsd],
		);
		const row = result.rows[0];
		if (!row || input.consumedMicroUsd > Number(row.reserved_micro_usd))
			throw new Error("Infrastructure settlement exceeds its reservation.");
		if (
			row.consumed_micro_usd !== null &&
			Number(row.consumed_micro_usd) !== input.consumedMicroUsd
		)
			throw new Error("Infrastructure settlement changed after confirmation.");
	}, existingClient);
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
