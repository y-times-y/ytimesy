import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

let db: PGlite;
const query = async (sql: string, params: unknown[] = []) => {
	const result = await db.query(sql, params);
	return { ...result, rowCount: result.affectedRows ?? result.rows.length };
};
const redeemed: string[] = [];
vi.mock("./database", () => ({ database: () => ({ query }) }));
vi.mock("./infrastructure-usage", () => ({
	withUsageLock: async (
		operation: (client: { query: typeof query }) => Promise<unknown>,
	) => {
		await query("begin");
		try {
			const result = await operation({ query });
			await query("commit");
			return result;
		} catch (error) {
			await query("rollback");
			throw error;
		}
	},
	redeemReferralResetIfBlocked: async (_client: unknown, userId: string) => {
		redeemed.push(userId);
		return false;
	},
}));

import {
	attributeReferral,
	ensureReferralCode,
	referralCounts,
	referralSummary,
	setReferralEnabled,
	settleReferrals,
} from "./referral";

const T0 = new Date("2026-11-25T10:00:00Z");
const after = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const IP_A = "203.0.113.10";
const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120 Safari/537";

async function user(id: string, email: string, verified = true) {
	await db.query(
		`insert into auth_user(id,email,"emailVerified") values($1,$2,$3)`,
		[id, email, verified],
	);
}
const turn = (id: string) =>
	db.query(
		"insert into usage_turn_counted(turn_id,user_id) values(gen_random_uuid(),$1)",
		[id],
	);
const row = async (id: string) =>
	(
		await db.query<{ status: string; reason: string | null }>(
			"select status,reason from referral where referred_user_id=$1",
			[id],
		)
	).rows[0];
const rewards = async () =>
	(
		await db.query<{ user_id: string; role: string }>(
			"select user_id,role from referral_reward order by role,user_id",
		)
	).rows;

beforeAll(async () => {
	vi.stubEnv("BETTER_AUTH_SECRET", "x".repeat(40));
	db = new PGlite();
	await db.exec(`create role anon; create role authenticated;
	 create table auth_user(id text primary key, email text not null unique, "emailVerified" boolean not null default true);
	 create table auth_session(id text primary key default gen_random_uuid()::text, "userId" text, "ipAddress" text, "userAgent" text, "createdAt" timestamptz default now());
	 create table auth_account(id text primary key default gen_random_uuid()::text, "userId" text, "providerId" text, "accountId" text);
	 create table usage_turn_counted(turn_id uuid primary key, user_id text not null references auth_user(id));`);
	await db.exec(
		readFileSync("supabase/migrations/20261125150000_referral.sql", "utf8"),
	);
});
afterAll(() => db.close());
beforeEach(async () => {
	redeemed.length = 0;
	await db.exec(
		`truncate referral_reward, referral, referral_code, usage_turn_counted, auth_session, auth_account, auth_user cascade; update referral_config set enabled=true;`,
	);
	await user("alice", "alice@example.test");
	await user("bob", "bob@example.test");
});

it("gives each account one stable personal code", async () => {
	const code = await ensureReferralCode("alice");
	expect(code).toMatch(/^r-[a-z0-9]{8}$/);
	expect(await ensureReferralCode("alice")).toBe(code);
	expect(await ensureReferralCode("bob")).not.toBe(code);
});

it("ignores unknown codes and an account's own code", async () => {
	const code = await ensureReferralCode("alice");
	expect(
		await attributeReferral({
			userId: "bob",
			email: "bob@example.test",
			code: "r-aaaaaaaa",
		}),
	).toBe("unknown_code");
	expect(
		await attributeReferral({
			userId: "alice",
			email: "alice@example.test",
			code,
		}),
	).toBe("self");
	expect((await db.query("select 1 from referral")).rows).toHaveLength(0);
});

it("the database itself refuses a self-referral row and a second reward", async () => {
	await expect(
		db.query(
			"insert into referral(referred_user_id,referrer_user_id,code) values('alice','alice','r-aaaaaaaa')",
		),
	).rejects.toThrow();
	await ensureReferralCode("alice");
	const code = await ensureReferralCode("alice");
	await attributeReferral({ userId: "bob", email: "bob@example.test", code });
	await db.query(
		"insert into referral_reward(referred_user_id,user_id,role) values('bob','bob','referred')",
	);
	await expect(
		db.query(
			"insert into referral_reward(referred_user_id,user_id,role) values('bob','bob','referred')",
		),
	).rejects.toThrow();
	await expect(
		db.query(
			"insert into referral_reward(referred_user_id,user_id,role) values('bob','alice','referred')",
		),
	).rejects.toThrow();
});

it("rewards both only after a verified address, a completed turn and the delay", async () => {
	const code = await ensureReferralCode("alice");
	await attributeReferral({
		userId: "bob",
		email: "bob@example.test",
		code,
		ip: "198.51.100.5",
		userAgent: UA,
		now: T0,
	});
	expect(await settleReferrals(after(5))).toMatchObject({
		qualified: 0,
		granted: 0,
	});
	await turn("bob");
	expect(await settleReferrals(after(10))).toMatchObject({
		qualified: 1,
		granted: 0,
	});
	expect(await settleReferrals(after(30))).toMatchObject({ granted: 0 });
	expect(await rewards()).toEqual([]);
	expect(await settleReferrals(after(75))).toMatchObject({ granted: 1 });
	expect(await rewards()).toEqual(
		[
			{ user_id: "bob", role: "referred" },
			{ user_id: "alice", role: "referrer" },
		].sort(
			(a, b) =>
				a.role.localeCompare(b.role) || a.user_id.localeCompare(b.user_id),
		),
	);
	expect(await row("bob")).toMatchObject({
		status: "granted",
		reason: "granted",
	});
	expect(redeemed.sort()).toEqual(["alice", "bob"]);
	// A second pass never grants again.
	expect(await settleReferrals(after(200))).toMatchObject({
		granted: 0,
		qualified: 0,
	});
	expect(await rewards()).toHaveLength(2);
});

it("does not qualify an unverified address", async () => {
	await user("carol", "carol@example.test", false);
	const code = await ensureReferralCode("alice");
	await attributeReferral({
		userId: "carol",
		email: "carol@example.test",
		code,
		now: T0,
	});
	await turn("carol");
	expect(await settleReferrals(after(5))).toMatchObject({ qualified: 0 });
	await db.query(`update auth_user set "emailVerified"=true where id='carol'`);
	expect(await settleReferrals(after(10))).toMatchObject({ qualified: 1 });
});

it("blocks the referrer's own inbox under another spelling", async () => {
	await user("alt", "alice+second@example.test");
	const code = await ensureReferralCode("alice");
	await attributeReferral({
		userId: "alt",
		email: "alice+second@example.test",
		code,
		now: T0,
	});
	expect(await row("alt")).toMatchObject({
		status: "blocked",
		reason: "same_email",
	});
	await turn("alt");
	await settleReferrals(after(120));
	expect(await rewards()).toEqual([]);
});

it("blocks the same inbox under Gmail dots for a second referral", async () => {
	await user("g1", "jane.doe@gmail.com");
	await user("g2", "janedoe+x@googlemail.com");
	const code = await ensureReferralCode("alice");
	await attributeReferral({
		userId: "g1",
		email: "jane.doe@gmail.com",
		code,
		now: T0,
	});
	await attributeReferral({
		userId: "g2",
		email: "janedoe+x@googlemail.com",
		code,
		now: after(1),
	});
	await turn("g1");
	await turn("g2");
	await settleReferrals(after(5));
	await settleReferrals(after(120));
	expect(await row("g1")).toMatchObject({ status: "granted" });
	expect(await row("g2")).toMatchObject({
		status: "blocked",
		reason: "duplicate_email",
	});
});

it("holds, and does not reward, a sign-up from the referrer's own network and browser", async () => {
	await db.query(
		`insert into auth_session("userId","ipAddress","userAgent") values('alice',$1,$2)`,
		[IP_A, UA],
	);
	const code = await ensureReferralCode("alice");
	await attributeReferral({
		userId: "bob",
		email: "bob@example.test",
		code,
		ip: "203.0.113.200",
		userAgent: UA,
		now: T0,
	});
	await turn("bob");
	await settleReferrals(after(5));
	await settleReferrals(after(120));
	expect(await row("bob")).toMatchObject({
		status: "held",
		reason: "same_network",
	});
	expect(await rewards()).toEqual([]);
});

it("holds sign-ups beyond the per-network daily limit", async () => {
	const code = await ensureReferralCode("alice");
	for (const [index, id] of ["n1", "n2", "n3", "n4"].entries()) {
		await user(id, `${id}@example.test`);
		await attributeReferral({
			userId: id,
			email: `${id}@example.test`,
			code,
			ip: "198.51.100.9",
			userAgent: UA,
			now: after(index),
		});
	}
	expect(await row("n3")).toMatchObject({ status: "attributed" });
	expect(await row("n4")).toMatchObject({
		status: "held",
		reason: "network_rate",
	});
});

it("blocks accounts that share a linked sign-in account", async () => {
	await db.query(
		`insert into auth_account("userId","providerId","accountId") values('alice','github','42'),('bob','github','42')`,
	);
	const code = await ensureReferralCode("alice");
	await attributeReferral({
		userId: "bob",
		email: "bob@example.test",
		code,
		now: T0,
	});
	await turn("bob");
	await settleReferrals(after(5));
	await settleReferrals(after(120));
	expect(await row("bob")).toMatchObject({
		status: "blocked",
		reason: "shared_linked_account",
	});
});

it("caps the referrer at three rewards in the period but still rewards the referred", async () => {
	const code = await ensureReferralCode("alice");
	for (const id of ["p1", "p2", "p3"]) {
		await user(id, `${id}@example.test`);
		await db.query(
			"insert into referral(referred_user_id,referrer_user_id,code,status,decided_at) values($1,'alice',$2,'granted',$3)",
			[id, code, new Date("2026-10-01T00:00:00Z")],
		);
		await db.query(
			"insert into referral_reward(referred_user_id,user_id,role,granted_at) values($1,'alice','referrer',$2)",
			[id, after(-60 * 24 * 5)],
		);
	}
	await attributeReferral({
		userId: "bob",
		email: "bob@example.test",
		code,
		now: T0,
	});
	await turn("bob");
	await settleReferrals(after(5));
	await settleReferrals(after(120));
	expect(await row("bob")).toMatchObject({
		status: "granted",
		reason: "referrer_capped",
	});
	expect((await rewards()).filter((r) => r.user_id === "bob")).toHaveLength(1);
	expect((await rewards()).filter((r) => r.role === "referrer")).toHaveLength(
		3,
	);
	const summary = await referralSummary("alice", after(130));
	expect(summary).toMatchObject({
		rewardsInPeriod: 3,
		rewardsCap: 3,
		enabled: true,
	});
	expect(summary.nextAvailableAt).not.toBeNull();
});

it("the kill switch stops attribution and grants and keeps what is pending", async () => {
	const code = await ensureReferralCode("alice");
	await attributeReferral({
		userId: "bob",
		email: "bob@example.test",
		code,
		now: T0,
	});
	await turn("bob");
	await settleReferrals(after(5));
	await setReferralEnabled(false);
	expect(await settleReferrals(after(120))).toEqual({
		qualified: 0,
		granted: 0,
		held: 0,
		blocked: 0,
	});
	await user("dan", "dan@example.test");
	expect(
		await attributeReferral({ userId: "dan", email: "dan@example.test", code }),
	).toBe("disabled");
	expect(await row("bob")).toMatchObject({ status: "pending" });
	await setReferralEnabled(true);
	expect(await settleReferrals(after(130))).toMatchObject({ granted: 1 });
});

it("counts referrals by status and reason for the operator", async () => {
	await user("alt", "alice+x@example.test");
	const code = await ensureReferralCode("alice");
	await attributeReferral({
		userId: "alt",
		email: "alice+x@example.test",
		code,
		now: T0,
	});
	await attributeReferral({
		userId: "bob",
		email: "bob@example.test",
		code,
		now: T0,
	});
	const counts = await referralCounts();
	expect(counts.byStatus).toEqual(
		expect.arrayContaining([
			{ status: "blocked", reason: "same_email", count: 1 },
			{ status: "attributed", reason: null, count: 1 },
		]),
	);
});
