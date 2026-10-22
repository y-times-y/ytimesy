import { isDevelopmentEnvironment } from "#/domain/development-environment";
import {
	type HarnessVariant,
	harnessVariantFromUnknown,
	PRODUCT_HARNESS_VARIANT,
} from "#/domain/harness-variant";
import { database } from "./database";
import {
	type InvocationSharedRead,
	invocationSharedRead,
	usableInThisInvocation,
} from "./database-scope";

/**
 * Development evaluations run as throwaway users (dev_eval_user). Only a
 * development deployment with YTIMESY_DEV_EVAL_USERS=1 reads that table,
 * never production or an unlabelled one, whatever the variable says.
 */
export function devEvalUsersEnabled(
	env: {
		readonly YTIMESY_DEV_EVAL_USERS?: string;
		readonly YTIMESY_ENVIRONMENT?: string;
	} = process.env,
): boolean {
	return env.YTIMESY_DEV_EVAL_USERS === "1" && isDevelopmentEnvironment(env);
}

type EvalUserRow = {
	owner_user_id: string;
	harness_variant: unknown;
};

// A user's eval row never changes after creation (or is deleted with the
// user), so one read per isolate is enough. Regular users cache as null.
// Read only in development (devEvalUsersEnabled); bounded so a long-lived
// isolate keeps at most the most recent users, oldest dropped first.
// A read still in flight is shared only within its own invocation
// (invocationSharedRead).
const rows = new Map<
	string,
	{ row: Promise<EvalUserRow | null> } & InvocationSharedRead
>();
const MAX_CACHED_USERS = 1000;

function evalUserRow(userId: string) {
	const cached = rows.get(userId);
	if (cached && usableInThisInvocation(cached)) return cached.row;
	const row = database()
		.query<EvalUserRow>(
			"select owner_user_id,harness_variant from dev_eval_user where user_id=$1",
			[userId],
		)
		.then((result) => result.rows[0] ?? null);
	if (rows.size >= MAX_CACHED_USERS && !cached)
		rows.delete(rows.keys().next().value as string);
	const entry = { row, ...invocationSharedRead(row) };
	rows.set(userId, entry);
	row.catch(() => {
		if (rows.get(userId) === entry) rows.delete(userId);
	});
	return row;
}

/**
 * Whose Codex subscription login serves this user: the eval user's owner,
 * else the user. Tokens are read and refreshed on that row only.
 */
export async function codexCredentialUserId(userId: string) {
	if (!devEvalUsersEnabled()) return userId;
	return (await evalUserRow(userId))?.owner_user_id ?? userId;
}

/**
 * Whether this is a throwaway eval user, whatever the deployment's switches
 * say: eval users own copies of their owner's project rows (same repository
 * name and installation), so nothing may push to GitHub for them anywhere.
 * Their model requests are also recorded for the runner (model-request-log.ts).
 */
export async function isDevEvalUser(userId: string): Promise<boolean> {
	return Boolean(await evalUserRow(userId));
}

/** The eval user's harness variant; the product's for everyone else. */
export async function harnessVariantForUser(
	userId: string,
): Promise<HarnessVariant> {
	if (!devEvalUsersEnabled()) return PRODUCT_HARNESS_VARIANT;
	const row = await evalUserRow(userId);
	return row
		? harnessVariantFromUnknown(row.harness_variant)
		: PRODUCT_HARNESS_VARIANT;
}
