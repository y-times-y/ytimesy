/**
 * Turns Y² on for projects that never chose (see src/server/adapters/y-backfill.ts).
 *
 *   node --import tsx scripts/backfill-y-default-on.ts            # dry run: counts only
 *   node --import tsx scripts/backfill-y-default-on.ts --apply    # apply, in batches
 *
 * Target: MIGRATION_DATABASE_URL, else DATABASE_URL. Run it only after the code
 * that reads project.y_choice is live. Safe to run again.
 */
import pg from "pg";
import { ySquaredBackfill } from "../src/server/adapters/y-backfill";
import { supabaseCertificate } from "./supabase-certificate";

const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error("Set MIGRATION_DATABASE_URL or DATABASE_URL.");
const client = new pg.Client({
	connectionString: url
		.replace(/[?&]sslrootcert=[^&]*/, "")
		.replace(/[?&]sslmode=[^&]*/, ""),
	ssl: { ca: supabaseCertificate(process.env), rejectUnauthorized: true },
});
await client.connect();
try {
	await client.query("set statement_timeout='20s'");
	const apply = process.argv.includes("--apply");
	console.log(
		JSON.stringify(await ySquaredBackfill(client, { apply }), null, 2),
	);
} finally {
	await client.end();
}
