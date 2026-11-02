import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { recordUserAttribution } from "../src/server/adapters/user-attribution";

let db: PGlite;
const query = async (sql: string, params?: unknown[]) => {
	const result = await db.query(sql, params);
	return { ...result, rowCount: result.affectedRows ?? result.rows.length };
};
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({ query }),
}));

beforeAll(async () => {
	db = new PGlite();
	await db.exec("create role anon; create role authenticated;");
	for (const file of [
		"20260913193000_identity_and_projects.sql",
		"20261102160000_user_attribution.sql",
	])
		await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
	await db.exec(
		`insert into auth_user(id,name,email,"emailVerified") values('alice','Alice','alice@example.test',true)`,
	);
});
afterAll(() => db.close());

it("stores the first touch once and never overwrites it", async () => {
	await recordUserAttribution("alice", {
		ref: "hackernews",
		utm_source: "hn",
		referrer_host: "news.ycombinator.com",
		landing_path: "/blog/harness-1-0",
		at: "2026-11-01T00:00:00.000Z",
	});
	await recordUserAttribution("alice", {
		ref: "x",
		at: "2026-11-02T00:00:00.000Z",
	});
	const rows = (
		await db.query<{ ref: string; utm_source: string; landing_path: string }>(
			"select ref,utm_source,landing_path from user_attribution where user_id='alice'",
		)
	).rows;
	expect(rows).toEqual([
		{ ref: "hackernews", utm_source: "hn", landing_path: "/blog/harness-1-0" },
	]);
});

it("rejects a ref outside [a-z0-9_-] and is deleted with the account", async () => {
	await db.exec(
		`insert into auth_user(id,name,email,"emailVerified") values('bob','Bob','bob@example.test',true)`,
	);
	await expect(
		recordUserAttribution("bob", {
			ref: "Bad Ref",
			at: new Date().toISOString(),
		}),
	).rejects.toThrow();
	await db.exec("delete from auth_user where id='alice'");
	expect((await db.query("select 1 from user_attribution")).rows).toHaveLength(
		0,
	);
});
