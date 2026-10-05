import type { PoolClient } from "pg";
import {
	infrastructureBalance,
	utcUsageMonth,
	validUsageAmount,
} from "#/domain/infrastructure-usage";
import { requireInfrastructureAdmin } from "../auth/infrastructure-admin";
import { database } from "./database";

type BudgetLimits = {
	defaultUserMicroUsd: number;
	fleetMicroUsd: number;
	lifetimeFleetMicroUsd: number;
};

export function infrastructureUsageLimits(): BudgetLimits {
	const read = (name: string) => {
		const value = process.env[name];
		if (!value?.trim()) throw new Error(`${name} must be configured.`);
		return validUsageAmount(Number(value));
	};
	return {
		defaultUserMicroUsd: read("YTIMESY_USER_MONTHLY_MICRO_USD"),
		fleetMicroUsd: read("YTIMESY_FLEET_MONTHLY_MICRO_USD"),
		lifetimeFleetMicroUsd: read("YTIMESY_FLEET_LIFETIME_MICRO_USD"),
	};
}

type UsageSummary = { consumed: string; reserved: string };

async function readBalance(
	client: Pick<PoolClient, "query">,
	userId: string,
	period: string,
	defaultUserMicroUsd: number,
) {
	const policy = await client.query<{ amount: string }>(
		`select coalesce((select monthly_micro_usd from infrastructure_usage_policy where user_id=$1),$3::bigint)
		 +coalesce((select sum(amount_micro_usd) from infrastructure_usage_adjustment where user_id=$1 and period=$2 and kind='grant'),0) as amount`,
		[userId, period, defaultUserMicroUsd],
	);
	const usage = await client.query<UsageSummary>(
		`select coalesce(sum(consumed_micro_usd),0) as consumed,
		 coalesce(sum(reserved_micro_usd) filter(where consumed_micro_usd is null),0) as reserved
		 from infrastructure_usage_reservation where user_id=$1 and (period=$2 or consumed_micro_usd is null)`,
		[userId, period],
	);
	return infrastructureBalance({
		allowanceMicroUsd: Number(policy.rows[0].amount),
		consumedMicroUsd: Number(usage.rows[0].consumed),
		reservedMicroUsd: Number(usage.rows[0].reserved),
	});
}

export async function userInfrastructureUsage(
	userId: string,
	client: Pick<PoolClient, "query"> = database(),
) {
	const limits = infrastructureUsageLimits();
	const period = utcUsageMonth();
	return {
		period,
		...(await readBalance(client, userId, period, limits.defaultUserMicroUsd)),
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
		const existing = await client.query<{
			user_id: string;
			resource_key: string;
			reserved_micro_usd: string;
			consumed_micro_usd: string | null;
		}>(
			"select user_id,resource_key,reserved_micro_usd,consumed_micro_usd from infrastructure_usage_reservation where id=$1",
			[input.id],
		);
		if (existing.rows[0]) {
			const row = existing.rows[0];
			if (
				row.user_id !== input.userId ||
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
		const owner = await client.query("select id from auth_user where id=$1", [
			input.userId,
		]);
		if (!owner.rows.length) throw new Error("Usage account is unavailable.");
		const period = utcUsageMonth();
		const balance = await readBalance(
			client,
			input.userId,
			period,
			limits.defaultUserMicroUsd,
		);
		if (balance.remainingMicroUsd < amountToReserve)
			throw new Error("Your cloud execution allowance is exhausted.");
		// Holds survive month boundaries until settled: an old run cannot evade the new fleet cap.
		const fleet = await client.query<{ amount: string }>(
			`select coalesce(sum(case when consumed_micro_usd is null then reserved_micro_usd else consumed_micro_usd end),0) as amount
			 from infrastructure_usage_reservation where period=$1 or consumed_micro_usd is null`,
			[period],
		);
		if (Number(fleet.rows[0].amount) + amountToReserve > limits.fleetMicroUsd)
			throw new Error("The fleet cloud execution budget is exhausted.");
		const lifetime = await client.query<{ amount: string }>(
			`select coalesce(sum(coalesce(consumed_micro_usd,reserved_micro_usd)),0) as amount
			 from infrastructure_usage_reservation`,
		);
		if (
			Number(lifetime.rows[0].amount) + amountToReserve >
			limits.lifetimeFleetMicroUsd
		)
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
		const result = await client.query<{
			reserved_micro_usd: string;
			consumed_micro_usd: string | null;
		}>(
			"select reserved_micro_usd,consumed_micro_usd from infrastructure_usage_reservation where id=$1 and user_id=$2",
			[input.id, input.userId],
		);
		const row = result.rows[0];
		if (!row || input.consumedMicroUsd > Number(row.reserved_micro_usd))
			throw new Error("Infrastructure settlement exceeds its reservation.");
		if (row.consumed_micro_usd !== null) {
			if (Number(row.consumed_micro_usd) !== input.consumedMicroUsd)
				throw new Error(
					"Infrastructure settlement changed after confirmation.",
				);
			return;
		}
		await client.query(
			"update infrastructure_usage_reservation set consumed_micro_usd=$3,settled_at=now() where id=$1 and user_id=$2",
			[input.id, input.userId, input.consumedMicroUsd],
		);
	}, existingClient);
}

export async function adjustInfrastructureAllowance(input: {
	id: string;
	actorId: string;
	userId: string;
	kind: "monthly_limit" | "grant";
	amountMicroUsd: number;
	reason: string;
}) {
	requireInfrastructureAdmin(input.actorId);
	validUsageAmount(input.amountMicroUsd);
	const reason = input.reason.trim();
	if (!reason || reason.length > 500)
		throw new Error("A concise grant reason is required.");
	if (input.kind !== "monthly_limit" && input.kind !== "grant")
		throw new Error("Invalid allowance adjustment.");
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
		if (input.kind === "monthly_limit")
			await client.query(
				"insert into infrastructure_usage_policy(user_id,monthly_micro_usd) values($1,$2) on conflict(user_id) do update set monthly_micro_usd=excluded.monthly_micro_usd",
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
		// Validate the resulting allowance inside this transaction so oversized cumulative grants roll back.
		await readBalance(
			client,
			input.userId,
			period,
			infrastructureUsageLimits().defaultUserMicroUsd,
		);
	});
}
