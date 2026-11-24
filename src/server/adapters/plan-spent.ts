import { isClaudeCodeRevision } from "#/domain/claude-code-route";
import type { ModelRoute } from "#/domain/model-failover";
import { database } from "./database";

/**
 * When the plan behind a route can serve again, while it is known to be
 * spent; null when it is not known to be (or the route is no plan). The
 * Claude subscription records `limited_until` when a run hit its limit; a
 * plan connection (the Grok plan) keeps its usage windows in `plan_usage`.
 */
export async function planSpentUntil(
	userId: string,
	route: Pick<ModelRoute, "connectionId" | "connectionRevision">,
): Promise<number | null> {
	if (route.connectionId === null) {
		if (!isClaudeCodeRevision(route.connectionRevision)) return null;
		const result = await database().query<{ until: Date | string | null }>(
			"select limited_until as until from claude_subscription where user_id=$1 and status='limited' and limited_until > now()",
			[userId],
		);
		const until = result.rows[0]?.until;
		return until ? new Date(until).getTime() : null;
	}
	const result = await database().query<{ plan_usage: unknown }>(
		"select plan_usage from model_connection where id=$1 and user_id=$2",
		[route.connectionId, userId],
	);
	return spentWindowReset(result.rows[0]?.plan_usage, Date.now());
}

/** The latest reset among a plan's used-up usage windows still in the future, or null. */
export function spentWindowReset(usage: unknown, now: number): number | null {
	const windows = (usage as { windows?: unknown } | null)?.windows;
	if (!Array.isArray(windows)) return null;
	let until: number | null = null;
	for (const window of windows as {
		usedPercent?: unknown;
		resetsAt?: unknown;
	}[]) {
		if (
			typeof window?.usedPercent === "number" &&
			window.usedPercent >= 100 &&
			typeof window.resetsAt === "number" &&
			window.resetsAt > now
		)
			until = Math.max(until ?? 0, window.resetsAt);
	}
	return until;
}

/** The failover column of the chat's last settled turn, raw (turnFailover parses it). */
export async function lastSettledTurnFailover(
	sessionId: string,
): Promise<unknown> {
	const result = await database().query<{ failover: unknown }>(
		`select failover from api_turn where session_id=$1
		 and state in ('completed','failed','cancelled') order by created_at desc limit 1`,
		[sessionId],
	);
	return result.rows[0]?.failover ?? null;
}
