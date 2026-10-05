import { readFile } from "node:fs/promises";
import { closeDatabase, database } from "#/server/adapters/database";

const migrations = [
	["20261003020000", "infrastructure_usage"],
	["20261003021000", "infrastructure_vm_identity"],
	["20261003022000", "workspace_retention"],
	["20261003023000", "infrastructure_cost_observations"],
	["20261003024000", "infrastructure_zero_runtime"],
	["20261003025000", "infrastructure_statements"],
] as const;
const projectRef = "zqkptvyvoyqqtpihlshw";
if (!process.argv.includes("--apply"))
	throw new Error("Explicit --apply is required.");
const linked = (await readFile("supabase/.temp/project-ref", "utf8")).trim();
const target = new URL(process.env.DATABASE_URL ?? "");
if (linked !== projectRef || !target.username.includes(projectRef))
	throw new Error("Not the approved development database.");
const client = await database().connect();
try {
	await client.query("begin");
	await client.query("select pg_advisory_xact_lock(81738420)");
	for (const [version, name] of migrations) {
		const sql = await readFile(
			`supabase/migrations/${version}_${name}.sql`,
			"utf8",
		);
		const existing = await client.query(
			"select version from supabase_migrations.schema_migrations where version=$1",
			[version],
		);
		if (!existing.rowCount) {
			await client.query(sql);
			await client.query(
				"insert into supabase_migrations.schema_migrations(version,name,statements) values($1,$2,$3)",
				[version, name, [sql]],
			);
		}
		console.info(`Development infrastructure migration ${version} applied.`);
	}
	await client.query("commit");
} catch (error) {
	await client.query("rollback");
	throw error;
} finally {
	client.release();
	await closeDatabase();
}
