import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { sessionSlugMatch, uuidSlugMatch } from "./slug-sql";

let db: PGlite;
const ids = [
	"3368c614-1366-48c0-8dd3-a402304e6b00",
	"3368c614-1366-48c0-0000-000000000000",
	"3368c614-1366-48c1-8dd3-a402304e6b00",
	"ffffffff-ffff-4fff-bfff-ffffffffffff",
];
beforeAll(async () => {
	db = new PGlite();
	await db.exec("create table t(id uuid primary key)");
	for (const id of ids) await db.query("insert into t values($1)", [id]);
});
afterAll(() => db.close());

/** What the old scan matched, for comparison. */
async function scanned(slug: string) {
	return (
		await db.query<{ id: string }>(
			"select id from t where 'ytimesy-ag-' || left(replace(id::text,'-',''),16)=$1 order by id",
			[slug],
		)
	).rows.map((row) => row.id);
}

it("finds a session slug's rows by key range, exactly as the scan did", async () => {
	for (const slug of [
		"ytimesy-ag-3368c614136648c0",
		"ytimesy-ag-3368c614136648c1",
		"ytimesy-ag-ffffffffffff4fff",
		"ytimesy-ag-3368c614136648c",
		"ytimesy-ag-3368C614136648C0",
		"ytimesy-ws-3368c614136648c0",
		"junk",
		"",
	]) {
		const found = (
			await db.query<{ id: string }>(
				`select id from t where ${sessionSlugMatch("$1")} order by id`,
				[slug],
			)
		).rows.map((row) => row.id);
		expect(found, slug).toEqual(await scanned(slug));
	}
	expect(await scanned("ytimesy-ag-3368c614136648c0")).toHaveLength(2);
});

it("finds a uuid slug's row by key and nothing for any other text", async () => {
	const query = (slug: string) =>
		db.query(
			`select id from t where ${uuidSlugMatch("$1", "ytimesy-ws-", "id")}`,
			[slug],
		);
	expect((await query(`ytimesy-ws-${ids[0]}`)).rows).toHaveLength(1);
	for (const slug of [
		`ytimesy-ws-${ids[0].toUpperCase()}`,
		`ytimesy-ws-${ids[0]}x`,
		"ytimesy-ws-not-a-uuid",
		`ytimesy-ag-${ids[0]}`,
	])
		expect((await query(slug)).rows, slug).toEqual([]);
});
