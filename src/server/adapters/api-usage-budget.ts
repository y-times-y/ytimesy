import type { PoolClient } from "pg";
import { database } from "./database";

/**
 * Daily safety nets against runaway loops on a user's own API keys, in
 * reserved tokens (each step reserves its whole prompt). Real coding tasks
 * send hundreds of thousands of tokens per step once files are read.
 */
function dailyLimit(name: string, fallback: number) {
	const value = Number(process.env[name]);
	return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** Conservative reservations are not refunded after uncertain provider failures. */
export async function reserveApiTokens(
	userId: string,
	sessionId: string,
	amount: number,
) {
	return reserveScopedTokens(userId, amount, async (client) => {
		const root = await client.query<{ id: string }>(
			`with recursive ancestors as (
		 select id,parent_session_id,0 as depth from agent_session where id=$1 and user_id=$2
		 union all select p.id,p.parent_session_id,a.depth+1 from agent_session p join ancestors a on p.id=a.parent_session_id where p.user_id=$2 and a.depth<4
		) select id from ancestors where parent_session_id is null`,
			[sessionId, userId],
		);
		if (!root.rows[0]) throw new Error("Invalid task hierarchy.");
		return {
			scope: `task:${root.rows[0].id}`,
			limit: dailyLimit("YTIMESY_API_TASK_DAILY_TOKENS", 5_000_000),
		};
	});
}

export async function reserveEnvironmentDiagnosisTokens(
	userId: string,
	workspaceId: string,
	amount: number,
) {
	return reserveScopedTokens(userId, amount, async (client) => {
		const workspace = await client.query(
			"select id from workspace where id=$1 and user_id=$2",
			[workspaceId, userId],
		);
		if (!workspace.rows[0]) throw new Error("Environment is not available.");
		return { scope: `environment:${workspaceId}`, limit: 100_000 };
	});
}

/** Memory's save hook and dreaming, on the user's own API connection. */
export async function reserveMemoryTokens(userId: string, amount: number) {
	return reserveScopedTokens(userId, amount, async () => ({
		scope: "memory",
		limit: dailyLimit("YTIMESY_API_MEMORY_DAILY_TOKENS", 2_000_000),
	}));
}

async function reserveScopedTokens(
	userId: string,
	amount: number,
	authorizedScope: (
		client: PoolClient,
	) => Promise<{ scope: string; limit: number }>,
) {
	if (!Number.isSafeInteger(amount) || amount <= 0)
		throw new Error("Invalid API budget reservation.");
	const client = await database().connect();
	try {
		await client.query("begin");
		const selected = await authorizedScope(client);
		for (const [scope, limit] of [
			["account", dailyLimit("YTIMESY_API_ACCOUNT_DAILY_TOKENS", 20_000_000)],
			[selected.scope, selected.limit],
		] as const) {
			const saved = await client.query(
				`insert into api_usage_budget(user_id,scope,reserved_tokens) select $1,$2,$3::bigint where $3::bigint <= $4::bigint
			 on conflict(user_id,scope,day) do update set reserved_tokens=api_usage_budget.reserved_tokens+excluded.reserved_tokens
			 where api_usage_budget.reserved_tokens+excluded.reserved_tokens <= $4 returning scope`,
				[userId, scope, amount, limit],
			);
			if (!saved.rowCount)
				throw new Error(
					"API usage safety budget reached. No additional model request was sent.",
				);
		}
		await client.query("commit");
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
}
