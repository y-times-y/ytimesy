import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import {
	USER_ACTION_LIMITS,
	UserActionRateLimited,
} from "../src/domain/user-action-rate";
import {
	consumeUserAction,
	requireUserAction,
	userActionLimitsEnabled,
} from "../src/server/adapters/user-action-rate";

let db: PGlite;
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({
		query: (sql: string, params?: unknown[]) => db.query(sql, params),
	}),
}));

beforeAll(async () => {
	db = new PGlite();
	await db.exec("create role anon; create role authenticated;");
	for (const file of (await readdir("supabase/migrations")).sort())
		await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
	await db.exec(
		`insert into auth_user(id,name,email,"emailVerified") values('alice','Alice','alice@example.test',true),('bob','Bob','bob@example.test',true)`,
	);
});
afterAll(() => db.close());
afterEach(async () => {
	vi.unstubAllEnvs();
	await db.exec("delete from user_action_rate");
});

it("limits only production unless explicitly enabled", async () => {
	expect(userActionLimitsEnabled({})).toBe(false);
	expect(userActionLimitsEnabled({ YTIMESY_ENVIRONMENT: "development" })).toBe(
		false,
	);
	expect(userActionLimitsEnabled({ YTIMESY_ENVIRONMENT: "production" })).toBe(
		true,
	);
	expect(userActionLimitsEnabled({ YTIMESY_USER_RATE_LIMITS: "true" })).toBe(
		true,
	);
	for (let i = 0; i < 30; i++) await consumeUserAction("alice", "chat-send");
	expect((await db.query("select 1 from user_action_rate")).rows).toEqual([]);
});

it("refuses chat sends past the per-minute limit, per user", async () => {
	vi.stubEnv("YTIMESY_ENVIRONMENT", "production");
	const { limit } = USER_ACTION_LIMITS["chat-send"];
	for (let i = 0; i < limit; i++) await consumeUserAction("alice", "chat-send");
	await expect(consumeUserAction("alice", "chat-send")).rejects.toBeInstanceOf(
		UserActionRateLimited,
	);
	await expect(consumeUserAction("bob", "chat-send")).resolves.toBeUndefined();
	await expect(
		consumeUserAction("alice", "project-create"),
	).resolves.toBeUndefined();
});

it("answers JSON endpoints with a 429 once project creation is over its limit", async () => {
	vi.stubEnv("YTIMESY_ENVIRONMENT", "production");
	const { limit } = USER_ACTION_LIMITS["project-create"];
	for (let i = 0; i < limit; i++)
		await requireUserAction("alice", "project-create");
	const refused = await requireUserAction("alice", "project-create").catch(
		(error: unknown) => error,
	);
	expect(refused).toBeInstanceOf(Response);
	expect((refused as Response).status).toBe(429);
	expect(await (refused as Response).text()).toMatch(/too many projects/);
});

it("starts a new window once the old one has passed", async () => {
	vi.stubEnv("YTIMESY_ENVIRONMENT", "production");
	await db.exec(
		`insert into user_action_rate(user_id,action,window_start,count) values('alice','vm-create',now()-interval '2 hours',999),('alice','vm-create',now()-interval '2 days',999)`,
	);
	await expect(
		consumeUserAction("alice", "vm-create"),
	).resolves.toBeUndefined();
	const rows = await db.query<{ count: number }>(
		"select count from user_action_rate where user_id='alice' order by window_start",
	);
	// The two-day-old window is pruned; the two-hour-old one no longer applies.
	expect(rows.rows.map((row) => row.count)).toEqual([999, 1]);
});
