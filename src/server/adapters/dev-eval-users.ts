import { isDevelopmentEnvironment } from "#/domain/development-environment";
import {
	DEFAULT_HARNESS_VARIANT,
	type HarnessVariant,
	harnessVariantFromUnknown,
} from "#/domain/harness-variant";
import { database } from "./database";

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
const rows = new Map<string, Promise<EvalUserRow | null>>();
const MAX_CACHED_USERS = 1000;

function evalUserRow(userId: string) {
	let row = rows.get(userId);
	if (!row) {
		row = database()
			.query<EvalUserRow>(
				"select owner_user_id,harness_variant from dev_eval_user where user_id=$1",
				[userId],
			)
			.then((result) => result.rows[0] ?? null);
		if (rows.size >= MAX_CACHED_USERS)
			rows.delete(rows.keys().next().value as string);
		rows.set(userId, row);
		row.catch(() => rows.delete(userId));
	}
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

/** The eval user's harness variant; the default for everyone else. */
export async function harnessVariantForUser(
	userId: string,
): Promise<HarnessVariant> {
	if (!devEvalUsersEnabled()) return DEFAULT_HARNESS_VARIANT;
	const row = await evalUserRow(userId);
	return row
		? harnessVariantFromUnknown(row.harness_variant)
		: DEFAULT_HARNESS_VARIANT;
}

/**
 * Eval users whose harness variant turns on pull request evidence (for the
 * periodic evidence expiry sweep). Empty outside development.
 */
export async function prEvidenceEvalUserIds(): Promise<string[]> {
	if (!devEvalUsersEnabled()) return [];
	const result = await database().query<{ user_id: string }>(
		"select user_id from dev_eval_user where harness_variant->>'prEvidence'='on' order by created_at limit 500",
	);
	return result.rows.map((row) => row.user_id);
}
