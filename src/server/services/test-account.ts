import { randomBytes, randomUUID } from "node:crypto";
import { CURRENT_LEGAL_VERSIONS } from "#/domain/legal-acceptance";
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
	action: "minted" | "refused" | "reset",
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
	input: { caller: unknown; action: "seed" | "y-counts"; apiKey?: string },
) {
	const caller = await authorize(db, settings, presentedToken, input.caller);
	const { seedTestAccount, yDefaultCounts } = await import(
		"./test-account-seed"
	);
	if (input.action === "y-counts") return yDefaultCounts(db);
	const userId = await flaggedTestUser(db);
	const result = await seedTestAccount(db, userId, { apiKey: input.apiKey });
	console.log(JSON.stringify({ event: "test_session.seed", caller }));
	return result;
}
