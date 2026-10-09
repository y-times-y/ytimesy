import { readFile } from "node:fs/promises";
import { closeDatabase, database } from "../src/server/adapters/database";

const version = "20261008120000";
const name = "api_turn_executor";
const projectRef = "zqkptvyvoyqqtpihlshw";
if (!process.argv.includes("--apply"))
	throw new Error("Explicit --apply is required.");
const linked = (await readFile("supabase/.temp/project-ref", "utf8")).trim();
if (
	linked !== projectRef ||
	!new URL(process.env.DATABASE_URL ?? "").username.includes(projectRef)
)
	throw new Error("Not the approved development database.");
const client = await database().connect();
try {
	await client.query("begin");
	await client.query("select pg_advisory_xact_lock(81738420)");
	const existing = await client.query(
		"select version from supabase_migrations.schema_migrations where version=$1",
		[version],
	);
	if (!existing.rowCount) {
		const sql = await readFile(
			`supabase/migrations/${version}_${name}.sql`,
			"utf8",
		);
		await client.query(sql);
		await client.query(
			"insert into supabase_migrations.schema_migrations(version,name,statements) values($1,$2,$3)",
			[version, name, [sql]],
		);
	}
	await client.query("commit");
	console.log(
		"Development executor assignment migrated. Existing turns remain on Node; cutover stays disabled.",
	);
} catch {
	await client.query("rollback");
	throw new Error(
		"Development executor migration failed; no credential diagnostics were logged.",
	);
} finally {
	client.release();
	await closeDatabase();
}
