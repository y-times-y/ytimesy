import { readFile } from "node:fs/promises";
import { closeDatabase, database } from "#/server/adapters/database";

const version = "20261003010000";
const projectRef = "zqkptvyvoyqqtpihlshw";
if (!process.argv.includes("--apply"))
	throw new Error("Explicit --apply is required.");
const linked = (await readFile("supabase/.temp/project-ref", "utf8")).trim();
const target = new URL(process.env.DATABASE_URL ?? "");
if (linked !== projectRef || !target.username.includes(projectRef))
	throw new Error("Not the approved development database.");
const sql = await readFile(
	`supabase/migrations/${version}_harness_evaluation_limits.sql`,
	"utf8",
);
const client = await database().connect();
try {
	await client.query("begin");
	await client.query("select pg_advisory_xact_lock(81738420)");
	const existing = await client.query(
		"select version from supabase_migrations.schema_migrations where version=$1",
		[version],
	);
	if (!existing.rowCount) {
		await client.query(sql);
		await client.query(
			"insert into supabase_migrations.schema_migrations(version,name,statements) values($1,$2,$3)",
			[version, "harness_evaluation_limits", [sql]],
		);
	}
	await client.query("commit");
	console.info(`Development evaluation migration ${version} applied.`);
} catch (error) {
	await client.query("rollback");
	throw error;
} finally {
	client.release();
	await closeDatabase();
}
