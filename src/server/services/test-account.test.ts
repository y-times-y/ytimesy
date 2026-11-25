import { describe, expect, it } from "vitest";
import {
	deriveTestSessionToken,
	hashTestSessionToken,
	TEST_ACCOUNT_EMAIL,
	TEST_ACCOUNT_ID,
	TEST_SESSION_MAX_PER_HOUR,
	TEST_SESSION_TTL_SECONDS,
} from "#/domain/test-account";
import {
	mintTestSession,
	resetTestAccount,
	seedTestUsage,
	type TestAccountDb,
	TestSessionRefused,
} from "./test-account";

const token = deriveTestSessionToken("r".repeat(40), "1");
const settings = {
	expectedHash: hashTestSessionToken(token),
	authSecret: "s".repeat(40),
	secureCookie: true,
	now: () => new Date("2026-11-24T12:00:00Z"),
};

/** A tiny fake that models only the rows these queries touch. */
function fakeDb(opts: { testUserFlagged: boolean; minted?: number }) {
	const sessions: unknown[][] = [];
	const events: unknown[][] = [];
	const deletes: unknown[][] = [];
	const usage: { sql: string; params: unknown[] }[] = [];
	const db = {
		async query(sql: string, params: unknown[] = []) {
			if (sql.startsWith("insert into auth_user")) return { rows: [] };
			if (sql.includes("from auth_user where id=$1"))
				return { rows: opts.testUserFlagged ? [{ id: TEST_ACCOUNT_ID }] : [] };
			if (sql.includes("count(*)"))
				return { rows: [{ n: String(opts.minted ?? 0) }] };
			if (sql.startsWith("insert into auth_session")) sessions.push(params);
			if (sql.startsWith("insert into test_session_event")) events.push(params);
			if (/usage_daily|usage_turn_counted/.test(sql))
				usage.push({ sql, params });
			if (sql.startsWith("select id from project where"))
				return { rows: [{ id: crypto.randomUUID() }] };
			if (sql.startsWith("delete from project")) {
				deletes.push(params);
				return { rows: [{ id: "p1" }] };
			}
			return { rows: [] };
		},
	};
	return {
		db: db as unknown as TestAccountDb,
		sessions,
		events,
		deletes,
		usage,
	};
}

const refusal = async (p: Promise<unknown>) =>
	p.then(
		() => "allowed",
		(e) => (e instanceof TestSessionRefused ? e.reason : "crash"),
	);

describe("test account sessions", () => {
	it("mints only for the flagged test user, short-lived, and logs the caller", async () => {
		const { db, sessions, events } = fakeDb({ testUserFlagged: true });
		const result = await mintTestSession(db, settings, token, "thread-42");
		expect(result.user).toEqual({
			id: TEST_ACCOUNT_ID,
			email: TEST_ACCOUNT_EMAIL,
		});
		expect(sessions).toHaveLength(1);
		expect(sessions[0][4]).toBe(TEST_ACCOUNT_ID);
		expect((sessions[0][1] as Date).getTime() - settings.now().getTime()).toBe(
			TEST_SESSION_TTL_SECONDS * 1000,
		);
		expect(events[0]).toEqual(["minted", "thread-42", null]);
		expect(result.cookie.name).toBe("__Secure-better-auth.session_token");
	});

	it("refuses when the reserved user is not flagged as the test account", async () => {
		const { db, sessions } = fakeDb({ testUserFlagged: false });
		expect(await refusal(mintTestSession(db, settings, token, "t"))).toBe(
			"user-is-not-test-account",
		);
		expect(sessions).toHaveLength(0);
	});

	it("refuses a wrong token, no token, and an unconfigured server", async () => {
		const { db, sessions } = fakeDb({ testUserFlagged: true });
		expect(await refusal(mintTestSession(db, settings, "nope", "t"))).toBe(
			"bad-token",
		);
		expect(await refusal(mintTestSession(db, settings, undefined, "t"))).toBe(
			"bad-token",
		);
		expect(
			await refusal(
				mintTestSession(
					db,
					{ ...settings, expectedHash: undefined },
					token,
					"t",
				),
			),
		).toBe("not-configured");
		expect(sessions).toHaveLength(0);
	});

	it("refuses a missing caller and rate limits an hour's mints", async () => {
		expect(
			await refusal(
				mintTestSession(
					fakeDb({ testUserFlagged: true }).db,
					settings,
					token,
					"",
				),
			),
		).toBe("bad-caller");
		expect(
			await refusal(
				mintTestSession(
					fakeDb({ testUserFlagged: true, minted: TEST_SESSION_MAX_PER_HOUR })
						.db,
					settings,
					token,
					"t",
				),
			),
		).toBe("rate-limited");
	});

	it("reset deletes only the test user's projects", async () => {
		const { db, deletes } = fakeDb({ testUserFlagged: true });
		expect(await resetTestAccount(db, settings, token, "t")).toEqual({
			projectsRemoved: 1,
		});
		expect(deletes).toEqual([[TEST_ACCOUNT_ID]]);
	});

	it("reset also clears the test user's usage rows, and only theirs", async () => {
		const { db, usage } = fakeDb({ testUserFlagged: true });
		await resetTestAccount(db, settings, token, "t");
		expect(usage.map((u) => u.params)).toEqual([
			[TEST_ACCOUNT_ID],
			[TEST_ACCOUNT_ID],
		]);
	});

	it("seeds usage only for the flagged test user, behind the token", async () => {
		const { db, usage, events } = fakeDb({ testUserFlagged: true });
		const result = await seedTestUsage(db, settings, token, "t");
		expect(result.usageRows).toBeGreaterThan(200);
		const inserts = usage.filter((u) =>
			u.sql.startsWith("insert into usage_daily"),
		);
		expect(inserts.length).toBeGreaterThan(0);
		expect(inserts.every((u) => u.params[0] === TEST_ACCOUNT_ID)).toBe(true);
		expect(events.at(-1)).toEqual(["seeded-usage", "t", null]);

		const unflagged = fakeDb({ testUserFlagged: false });
		expect(
			await refusal(seedTestUsage(unflagged.db, settings, token, "t")),
		).toBe("user-is-not-test-account");
		expect(unflagged.usage).toHaveLength(0);
		expect(await refusal(seedTestUsage(db, settings, "nope", "t"))).toBe(
			"bad-token",
		);
	});
});
