/**
 * Applies committed migrations (supabase/migrations) that the target database
 * has not recorded, in order, each in its own transaction, recording them in
 * supabase_migrations.schema_migrations exactly as the Supabase CLI does.
 *
 *   pnpm db:migrate            # show what would be applied
 *   pnpm db:migrate --apply    # apply
 *
 * Target: MIGRATION_DATABASE_URL, else DATABASE_URL (session pooler or direct).
 * TLS verifies the server against SUPABASE_CA_PATH (default .secrets/supabase-ca.crt).
 */
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { supabaseCertificate } from "./supabase-certificate";

const apply = process.argv.includes("--apply");
const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error("Set MIGRATION_DATABASE_URL or DATABASE_URL.");
const caPath = process.env.SUPABASE_CA_PATH ?? ".secrets/supabase-ca.crt";
const client = new pg.Client({
	// TLS options come from here, not from the URL, so verification is explicit.
	connectionString: url
		.replace(/[?&]sslrootcert=[^&]*/, "")
		.replace(/[?&]sslmode=[^&]*/, ""),
	ssl: {
		ca: supabaseCertificate(process.env, caPath),
		rejectUnauthorized: true,
	},
});

await client.connect();
try {
	await client.query("create schema if not exists supabase_migrations");
	await client.query(
		"create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text)",
	);
	const recorded = new Set(
		(
			await client.query<{ version: string }>(
				"select version from supabase_migrations.schema_migrations",
			)
		).rows.map((row) => row.version),
	);
	const pending = readdirSync("supabase/migrations")
		.filter((file) => /^\d{14}_.+\.sql$/.test(file))
		.sort()
		.filter((file) => !recorded.has(file.slice(0, 14)));
	if (!pending.length) {
		console.log("Database is up to date.");
	} else {
		console.log(`${pending.length} migration(s) not recorded:`);
		for (const file of pending) console.log(`  ${file}`);
	}
	if (apply)
		for (const file of pending) {
			const sql = readFileSync(`supabase/migrations/${file}`, "utf8");
			await client.query("begin");
			try {
				await client.query(sql);
				await client.query(
					"insert into supabase_migrations.schema_migrations (version, statements, name) values ($1, $2, $3)",
					[file.slice(0, 14), [sql], file.slice(15, -4)],
				);
				await client.query("commit");
				console.log(`applied ${file}`);
			} catch (error) {
				await client.query("rollback");
				throw new Error(
					`${file} failed and was rolled back: ${(error as Error).message}`,
				);
			}
		}
	else if (pending.length)
		console.log("Dry run. Re-run with --apply to apply.");
} finally {
	await client.end();
}
