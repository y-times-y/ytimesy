import type { PoolClient } from "pg";
import {
	USER_ACTION_LIMITS,
	type UserAction,
	UserActionRateLimited,
} from "#/domain/user-action-rate";
import { database } from "./database";

/**
 * Limits apply in production (abuse protection for the public beta) and
 * wherever YTIMESY_USER_RATE_LIMITS=true; development and evaluations, whose
 * throwaway users legitimately burst, are not limited.
 */
export function userActionLimitsEnabled(
	env: Readonly<Record<string, string | undefined>> = process.env,
) {
	return (
		env.YTIMESY_ENVIRONMENT === "production" ||
		env.YTIMESY_USER_RATE_LIMITS === "true"
	);
}

/**
 * Counts one action against the user's current window and refuses it past
 * the limit (the refused attempt still counts, so hammering does not reset
 * anything). One statement: concurrent requests serialize on the row.
 */
export async function consumeUserAction(
	userId: string,
	action: UserAction,
	client: Pick<PoolClient, "query"> = database(),
) {
	if (!userActionLimitsEnabled()) return;
	const { limit, windowSeconds } = USER_ACTION_LIMITS[action];
	const result = await client.query<{ count: number }>(
		`with pruned as (
			delete from user_action_rate where user_id=$1 and action=$2 and window_start < now()-interval '1 day'
		)
		insert into user_action_rate(user_id,action,window_start,count)
		values($1,$2,to_timestamp(floor(extract(epoch from now())/$3)*$3),1)
		on conflict(user_id,action,window_start) do update set count=user_action_rate.count+1
		returning count`,
		[userId, action, windowSeconds],
	);
	if (Number(result.rows[0]?.count) > limit)
		throw new UserActionRateLimited(action);
}

/**
 * Gives one count back, for an action that was counted before it was known to
 * happen (a machine create the provider then refused). Never throws: it is
 * bookkeeping, and the worst case is the old over-count.
 */
export async function refundUserAction(
	userId: string,
	action: UserAction,
	client: Pick<PoolClient, "query"> = database(),
) {
	if (!userActionLimitsEnabled()) return;
	const { windowSeconds } = USER_ACTION_LIMITS[action];
	try {
		await client.query(
			`update user_action_rate set count=greatest(count-1,0)
			 where user_id=$1 and action=$2 and window_start=to_timestamp(floor(extract(epoch from now())/$3)*$3)`,
			[userId, action, windowSeconds],
		);
	} catch {
		console.warn("user_action.refund_failed", { action });
	}
}

/** For JSON endpoints: the same refusal as an HTTP 429. */
export async function requireUserAction(userId: string, action: UserAction) {
	try {
		await consumeUserAction(userId, action);
	} catch (error) {
		if (error instanceof UserActionRateLimited)
			throw new Response(error.message, { status: 429 });
		throw error;
	}
}
