import { randomBytes, randomUUID } from "node:crypto";
import { CURRENT_LEGAL_VERSIONS } from "#/domain/legal-acceptance";
import { syntheticUsage } from "#/domain/synthetic-usage";
import {
	mintRefusal,
	normalizeCaller,
	signedSessionCookie,
	TEST_ACCOUNT_EMAIL,
	TEST_ACCOUNT_ID,
	TEST_ACCOUNT_NAME,
	TEST_SESSION_TTL_SECONDS,
} from "#/domain/test-account";

/** The part of a database client the test account needs. */
export type TestAccountDb = {
	query<Row = Record<string, unknown>>(
		sql: string,
		params?: unknown[],
	): Promise<{ rows: Row[] }>;
};

export class TestSessionRefused extends Error {
	constructor(readonly reason: string) {
		super(`Test session refused: ${reason}`);
	}
}

type Settings = {
	/** sha256 of the capability token (Worker secret). */
	expectedHash: string | undefined;
	/** The auth signing secret; signs the cookie so callers never need it. */
	authSecret: string;
	secureCookie: boolean;
	now?: () => Date;
};

async function record(
	db: TestAccountDb,
	action: "minted" | "refused" | "reset" | "seeded-usage",
	caller: string,
	reason?: string,
) {
	await db
		.query(
			"insert into test_session_event(action,caller,reason) values($1,$2,$3)",
			[action, caller.slice(0, 120), reason ?? null],
		)
		.catch(() => undefined);
}

/**
 * Finds or creates the test user, and returns its id only when the row is
 * flagged. An existing row with the reserved id or email that is NOT flagged
 * is never touched or used.
 */
async function flaggedTestUser(db: TestAccountDb) {
	await db.query(
		`insert into auth_user(id,name,email,"emailVerified","createdAt","updatedAt",is_test_account)
		 values($1,$2,$3,true,now(),now(),true)
		 on conflict do nothing`,
		[TEST_ACCOUNT_ID, TEST_ACCOUNT_NAME, TEST_ACCOUNT_EMAIL],
	);
	const found = await db.query<{ id: string }>(
		"select id from auth_user where id=$1 and email=$2 and is_test_account",
		[TEST_ACCOUNT_ID, TEST_ACCOUNT_EMAIL],
	);
	const id = found.rows[0]?.id;
	if (id !== TEST_ACCOUNT_ID)
		throw new TestSessionRefused("user-is-not-test-account");
	await db
		.query(
			`insert into legal_acceptance(user_id,terms_version,privacy_version,source)
		 select $1,$2,$3,'signup' where not exists (select 1 from legal_acceptance where user_id=$1)`,
			[
				id,
				CURRENT_LEGAL_VERSIONS.termsVersion,
				CURRENT_LEGAL_VERSIONS.privacyVersion,
			],
		)
		.catch(() => undefined);
	return id;
}

async function authorize(
	db: TestAccountDb,
	settings: Settings,
	presentedToken: string | undefined,
	rawCaller: unknown,
) {
	const caller = normalizeCaller(rawCaller);
	const since = await db
		.query<{ n: string }>(
			"select count(*)::text as n from test_session_event where action='minted' and at > now() - interval '1 hour'",
		)
		.catch(() => ({ rows: [{ n: "0" }] }));
	const refusal = mintRefusal({
		expectedHash: settings.expectedHash,
		presentedToken,
		caller,
		mintedLastHour: Number(since.rows[0]?.n ?? 0),
	});
	if (refusal) {
		if (refusal !== "not-configured" && refusal !== "bad-token")
			await record(db, "refused", caller ?? "invalid", refusal);
		throw new TestSessionRefused(refusal);
	}
	return caller as string;
}

/** A short session for the test user only; returns the cookie to set. */
export async function mintTestSession(
	db: TestAccountDb,
	settings: Settings,
	presentedToken: string | undefined,
	rawCaller: unknown,
) {
	const caller = await authorize(db, settings, presentedToken, rawCaller);
	const userId = await flaggedTestUser(db);
	const token = randomBytes(24).toString("base64url");
	const now = (settings.now ?? (() => new Date()))();
	const expiresAt = new Date(now.getTime() + TEST_SESSION_TTL_SECONDS * 1000);
	await db.query(
		`insert into auth_session(id,"expiresAt",token,"updatedAt","userId") values($1,$2,$3,$4,$5)`,
		[randomUUID(), expiresAt, token, now, userId],
	);
	await record(db, "minted", caller);
	console.log(
		JSON.stringify({ event: "test_session.minted", caller, expiresAt }),
	);
	return {
		cookie: signedSessionCookie(
			token,
			settings.authSecret,
			settings.secureCookie,
		),
		expiresAt: expiresAt.toISOString(),
		user: { id: userId, email: TEST_ACCOUNT_EMAIL },
	};
}

/** Deletes the test user's projects (and, by cascade, their data). Nobody else's. */
export async function resetTestAccount(
	db: TestAccountDb,
	settings: Settings,
	presentedToken: string | undefined,
	rawCaller: unknown,
) {
	const caller = await authorize(db, settings, presentedToken, rawCaller);
	const userId = await flaggedTestUser(db);
	// Seeded usage keeps its rows when its project goes (set null), so it is deleted first.
	await db.query("delete from usage_daily where user_id=$1", [userId]);
	await db.query("delete from usage_turn_counted where user_id=$1", [userId]);
	await clearSyntheticAccounts(db, userId);
	const removed = await db.query(
		"delete from project where user_id=$1 returning id",
		[userId],
	);
	await record(db, "reset", caller);
	console.log(
		JSON.stringify({
			event: "test_session.reset",
			caller,
			projects: removed.rows.length,
		}),
	);
	return { projectsRemoved: removed.rows.length };
}

/** Capability-guarded extras: `seed` (model + project) and `y-counts` (aggregates only). */
export async function runTestAccountAction(
	db: TestAccountDb,
	settings: Settings,
	presentedToken: string | undefined,
	input: {
		caller: unknown;
		action:
			| "seed"
			| "seed-github-unlinked"
			| "seed-setup-building"
			| "seed-setup-failed"
			| "seed-setup-ready"
			| "y-counts"
			| "repo-ids"
			| "vm-map"
			| "seed-accounts"
			| "simulate-limit";
		apiKey?: string;
		slugs?: string[];
	},
) {
	const caller = await authorize(db, settings, presentedToken, input.caller);
	const { seedRepositoryIds, seedTestAccount, yDefaultCounts } = await import(
		"./test-account-seed"
	);
	if (input.action === "repo-ids") return seedRepositoryIds(db);
	if (input.action === "vm-map")
		return (await import("./test-account-vm-map")).mapVmSlugs(
			db,
			input.slugs ?? [],
		);
	if (input.action === "y-counts") return yDefaultCounts(db);
	if (input.action === "seed-accounts" || input.action === "simulate-limit") {
		const userId = await flaggedTestUser(db);
		console.log(
			JSON.stringify({ event: `test_session.${input.action}`, caller }),
		);
		return input.action === "seed-accounts"
			? seedSyntheticAccounts(db, userId)
			: simulateSyntheticLimit(userId);
	}
	const userId = await flaggedTestUser(db);
	const result = await seedTestAccount(db, userId, {
		apiKey: input.apiKey,
		githubUnlinked: input.action === "seed-github-unlinked",
		setupState:
			input.action === "seed-setup-building"
				? "building"
				: input.action === "seed-setup-failed"
					? "failed"
					: input.action === "seed-setup-ready"
						? "ready"
						: undefined,
	});
	console.log(JSON.stringify({ event: "test_session.seed", caller }));
	return result;
}

/** Two made-up repositories for the seeded usage; the ids cannot match a real GitHub repository. */
const SEED_PROJECTS = [
	{ repositoryId: 9_000_000_001, name: "synthetic/web-app" },
	{ repositoryId: 9_000_000_002, name: "synthetic/api-service" },
	// A long name, so the sidebar's project filter can be checked for truncation.
	{
		repositoryId: 9_000_000_003,
		name: "synthetic/a-repository-with-an-unusually-long-name-for-truncation-checks",
	},
] as const;

/**
 * Replaces the test user's daily usage with made-up rows so the Usage page's
 * heatmap has something to show. Only the test user's rows, the same fixed
 * target as mint and reset; `reset` clears them again.
 */
export async function seedTestUsage(
	db: TestAccountDb,
	settings: Settings,
	presentedToken: string | undefined,
	rawCaller: unknown,
) {
	const caller = await authorize(db, settings, presentedToken, rawCaller);
	const userId = await flaggedTestUser(db);
	const today = (settings.now ?? (() => new Date()))()
		.toISOString()
		.slice(0, 10);
	const projectIds: string[] = [];
	for (const project of SEED_PROJECTS) {
		// No conflict target: the project's unique key has changed before (now it includes repository_set_key).
		await db.query(
			`insert into project(id,user_id,repository_id,installation_id,full_name,branch)
			 values($1,$2,$3,$3,$4,'main') on conflict do nothing`,
			[randomUUID(), userId, project.repositoryId, project.name],
		);
		const row = await db.query<{ id: string }>(
			"select id from project where user_id=$1 and repository_id=$2 and repository_set_key=''",
			[userId, project.repositoryId],
		);
		projectIds.push(row.rows[0]?.id as string);
	}
	await db.query("delete from usage_daily where user_id=$1", [userId]);
	const rows = syntheticUsage(today);
	for (let at = 0; at < rows.length; at += 200) {
		const batch = rows.slice(at, at + 200);
		await db.query(
			`insert into usage_daily(user_id,day,provider,model_id,project_id,source,turns,unknown_turns,input_tokens,output_tokens,cache_read_tokens)
			 select $1,r.day::date,r.provider,r.model_id,
			        case r.project when 0 then $3::uuid when 1 then $4::uuid end,
			        r.source,r.turns,r.unknown_turns,r.input_tokens,r.output_tokens,r.cache_read_tokens
			 from jsonb_to_recordset($2::jsonb) as r(day text,provider text,model_id text,project int,source text,turns int,unknown_turns int,input_tokens bigint,output_tokens bigint,cache_read_tokens bigint)`,
			[
				userId,
				JSON.stringify(
					batch.map((r) => ({
						day: r.day,
						provider: r.provider,
						model_id: r.modelId,
						project: r.project,
						source: r.source,
						turns: r.turns,
						unknown_turns: r.unknownTurns,
						input_tokens: r.inputTokens,
						output_tokens: r.outputTokens,
						cache_read_tokens: r.cacheReadTokens,
					})),
				),
				projectIds[0],
				projectIds[1],
			],
		);
	}
	await record(db, "seeded-usage", caller);
	console.log(
		JSON.stringify({
			event: "test_session.seeded_usage",
			caller,
			rows: rows.length,
		}),
	);
	return { usageRows: rows.length };
}

/** The made-up tokens of seeded accounts: the right shape, valid nowhere. */
const SYNTHETIC_PREFIX = "sk-ant-oat01-synthetic-test-account-";
const SYNTHETIC_TOKEN = (n: number) =>
	`${SYNTHETIC_PREFIX}${n}-${"x".repeat(24)}`;

/**
 * Removes only what seed-accounts made: an account whose token is the
 * synthetic one (read after opening it, since a switch moves accounts
 * between rows). Another run's real connection is never touched.
 */
async function clearSyntheticAccounts(db: TestAccountDb, userId: string) {
	const { unseal } = await import("../auth/token-vault");
	const synthetic = async (sealed: string, purpose: string) =>
		(await unseal(sealed, { purpose, userId }).catch(() => "")).startsWith(
			SYNTHETIC_PREFIX,
		);
	const slot = (
		await db.query<{ sealed_token: string }>(
			"select sealed_token from claude_subscription where user_id=$1",
			[userId],
		)
	).rows[0];
	if (slot && (await synthetic(slot.sealed_token, "claude-subscription")))
		await db.query("delete from claude_subscription where user_id=$1", [
			userId,
		]);
	const waiting = await db.query<{ id: string; sealed_auth: string }>(
		"select id::text,sealed_auth from subscription_account where user_id=$1 and provider='claude'",
		[userId],
	);
	for (const row of waiting.rows)
		if (await synthetic(row.sealed_auth, `subscription-account:${row.id}`))
			await db.query("delete from subscription_account where id=$1::uuid", [
				row.id,
			]);
	await db.query(
		"update agent_session set subscription_pin=null where user_id=$1",
		[userId],
	);
}

/**
 * Three made-up Claude plan accounts for the test user (the first in use),
 * sealed like real ones, with tokens valid nowhere, to look at the accounts
 * UI and to run limit failover without a real provider. Only the test user's
 * rows; `reset` removes them. No turn is run with them.
 */
export async function seedSyntheticAccounts(db: TestAccountDb, userId: string) {
	const { seal } = await import("../auth/token-vault");
	await clearSyntheticAccounts(db, userId);
	const existing = await db.query(
		"select 1 from claude_subscription where user_id=$1",
		[userId],
	);
	if (existing.rows.length)
		throw new Error("The test account already has a Claude connection.");
	await db.query(
		`insert into claude_subscription(user_id,sealed_token,status,label,priority,activated_at)
		 values($1,$2,'connected','Personal',0,now()-interval '1 hour')`,
		[
			userId,
			await seal(SYNTHETIC_TOKEN(1), {
				purpose: "claude-subscription",
				userId,
			}),
		],
	);
	const names = ["Work", "Team"];
	for (const [index, label] of names.entries()) {
		const id = randomUUID();
		await db.query(
			`insert into subscription_account(id,user_id,provider,label,external_id,sealed_auth,priority)
			 values($1,$2,'claude',$3,$4,$5,$6)`,
			[
				id,
				userId,
				label,
				`synthetic-${index + 2}`,
				await seal(SYNTHETIC_TOKEN(index + 2), {
					purpose: `subscription-account:${id}`,
					userId,
				}),
				index + 1,
			],
		);
	}
	return { accounts: 3 };
}

/**
 * A simulated plan-limit answer for the account in use: the real rotation
 * runs (the account rests until a reported reset 90 minutes away and the
 * next takes over). Returns what happened, never a token.
 */
export async function simulateSyntheticLimit(userId: string) {
	const { rotateAfterLimit } = await import(
		"../adapters/subscription-accounts"
	);
	const rotation = await rotateAfterLimit(userId, "claude", {
		reportedResetAt: Date.now() + 90 * 60_000,
	});
	return {
		outcome: rotation.kind,
		...(rotation.kind === "rotated" ? { nowServing: rotation.to.label } : {}),
	};
}
