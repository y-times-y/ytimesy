import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { recordCronBlip } from "../src/server/adapters/owner-alerts";

let db: PGlite;
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({
		query: async (sql: string, params?: unknown[]) => {
			const result = await db.query(sql, params);
			return { ...result, rowCount: result.affectedRows ?? result.rows.length };
		},
	}),
}));

beforeAll(async () => {
	db = new PGlite();
	await db.exec("create role anon; create role authenticated;");
	for (const file of (await readdir("supabase/migrations")).sort())
		await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
});
afterAll(() => db.close());

it("keeps a job's blip episode until its window passes, then starts a new one", async () => {
	const job = "maintenance:memory-dreams";
	expect(await recordCronBlip(job, 11)).toBeNull();
	const started = await recordCronBlip(job, 11);
	expect(started).toBeInstanceOf(Date);
	// Later blips in the episode keep its start.
	expect((await recordCronBlip(job, 11))?.getTime()).toBe(started?.getTime());
	await db.query(
		"update owner_alert set created_at = now() - interval '20 minutes' where dedupe_key = $1",
		[`blip:${job}`],
	);
	expect(await recordCronBlip(job, 11)).toBeNull();
	expect(await recordCronBlip(job, 11)).toBeInstanceOf(Date);
	// Other jobs, and the hourly alert keys, are separate rows.
	expect(await recordCronBlip("maintenance:refresh", 121)).toBeNull();
	const rows = await db.query<{ dedupe_key: string }>(
		"select dedupe_key from owner_alert order by dedupe_key",
	);
	expect(rows.rows.map((row) => row.dedupe_key)).toEqual([
		"blip:maintenance:memory-dreams",
		"blip:maintenance:refresh",
	]);
});
