import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import type { fleetCostProjection } from "#/domain/infrastructure-costs";
import { infrastructureStatementSchema } from "#/domain/infrastructure-statement";
import { database } from "#/server/adapters/database";
import {
	importInfrastructureStatement,
	recentInfrastructureStatements,
} from "#/server/adapters/infrastructure-statements";
import {
	adjustInfrastructureAllowance,
	userInfrastructureUsage,
} from "#/server/adapters/infrastructure-usage";
import { auth, requireUser } from "#/server/auth/auth";
import {
	isInfrastructureAdmin,
	requireInfrastructureAdmin,
} from "#/server/auth/infrastructure-admin";

export const infrastructureUsageFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const headers = getRequest().headers;
		const user = await requireUser(headers);
		const authenticated = await auth().api.getSession({ headers });
		return {
			userId: user.id,
			requiresAdminSignIn: !authenticated && isInfrastructureAdmin(user.id),
			admin:
				authenticated?.user.id === user.id && isInfrastructureAdmin(user.id),
			...(await userInfrastructureUsage(user.id)),
		};
	},
);

export const infrastructureUsersFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const user = await requireAuthenticatedAdmin();
		requireInfrastructureAdmin(user.id);
		const result = await database().query<{
			id: string;
			name: string;
			email: string;
		}>("select id,name,email from auth_user order by name,id limit 200");
		return result.rows;
	},
);

export const adjustInfrastructureUsageFn = createServerFn({ method: "POST" })
	.validator(
		z.object({
			id: z.string().uuid(),
			userId: z.string().min(1).max(200),
			kind: z.enum(["five_hour_limit", "weekly_limit"]),
			amountMicroUsd: z.number().int().min(0).max(1_000_000_000_000),
			reason: z.string().trim().min(1).max(500),
		}),
	)
	.handler(async ({ data }) => {
		const user = await requireAuthenticatedAdmin();
		await adjustInfrastructureAllowance({ ...data, actorId: user.id });
		return userInfrastructureUsage(data.userId);
	});

async function requireAuthenticatedAdmin() {
	const session = await auth().api.getSession({
		headers: getRequest().headers,
	});
	if (!session)
		throw new Response("Sign in to manage allowances.", { status: 401 });
	requireInfrastructureAdmin(session.user.id);
	return session.user;
}

export const infrastructureStatementsFn = createServerFn({
	method: "GET",
}).handler(async () => {
	await requireAuthenticatedAdmin();
	return recentInfrastructureStatements();
});

export const importInfrastructureStatementFn = createServerFn({
	method: "POST",
})
	.validator(infrastructureStatementSchema)
	.handler(async ({ data }) => {
		const user = await requireAuthenticatedAdmin();
		return importInfrastructureStatement(user.id, data);
	});

export const infrastructureFleetCostsFn = createServerFn({
	method: "GET",
}).handler(async () => {
	await requireAuthenticatedAdmin();
	const result = await database().query<{
		observed_at: Date;
		projection: ReturnType<typeof fleetCostProjection>;
	}>(
		"select observed_at,projection from infrastructure_fleet_observation where singleton=true",
	);
	const row = result.rows[0];
	return row
		? { ...row.projection, observedAt: row.observed_at.toISOString() }
		: null;
});

export const infrastructureAllowanceAuditFn = createServerFn({
	method: "GET",
}).handler(async () => {
	await requireAuthenticatedAdmin();
	const result = await database().query<{
		id: string;
		actor_id: string;
		user_id: string;
		kind: string;
		amount_micro_usd: string;
		reason: string;
		created_at: Date;
	}>(
		"select id,actor_id,user_id,kind,amount_micro_usd,reason,created_at from infrastructure_usage_adjustment order by created_at desc,id desc limit 50",
	);
	return result.rows.map((row) => ({
		id: row.id,
		actorId: row.actor_id,
		userId: row.user_id,
		kind: row.kind,
		amountMicroUsd: Number(row.amount_micro_usd),
		reason: row.reason,
		createdAt: row.created_at.toISOString(),
	}));
});
