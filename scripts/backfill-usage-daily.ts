/**
 * Fills usage_daily from the turns already settled (docs: the Usage page's
 * heatmap needs history). Safe to run again: usage_turn_counted skips a turn
 * counted before, and the live writer in finalizeApiTurn uses the same table.
 *
 *   node --import tsx scripts/backfill-usage-daily.ts            # dry run: counts only
 *   node --import tsx scripts/backfill-usage-daily.ts --apply    # apply, in batches
 *
 * Target: MIGRATION_DATABASE_URL, else DATABASE_URL. Run it after the
 * migration and the deploy that writes the rollup. Reads a page of turns at a
 * time (newest first, by created_at) so it never holds a long scan.
 */
import pg from "pg";
import { turnUsageFact } from "../src/domain/usage-report";
import { recordTurnUsage } from "../src/server/adapters/usage-rollup";
import { supabaseCertificate } from "./supabase-certificate";

const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error("Set MIGRATION_DATABASE_URL or DATABASE_URL.");
const apply = process.argv.includes("--apply");
const PAGE = 200;
const client = new pg.Client({
	connectionString: url
		.replace(/[?&]sslrootcert=[^&]*/, "")
		.replace(/[?&]sslmode=[^&]*/, ""),
	ssl: { ca: supabaseCertificate(process.env), rejectUnauthorized: true },
});
await client.connect();
try {
	await client.query("set statement_timeout='20s'");
	let cursor: string | null = null;
	let counted = 0;
	let seen = 0;
	for (;;) {
		// A turn's items are its own array (older rows) or {"from": id} into the chat's items (newer rows).
		const page: {
			rows: {
				id: string;
				model_id: string;
				created_at: string;
				items: unknown;
			}[];
		} = await client.query(
			`select t.id,t.model_id,t.created_at::text,
				        case when jsonb_typeof(t.items)='array' then t.items
				             else coalesce((select jsonb_agg(e order by o) from jsonb_array_elements(s.items) with ordinality x(e,o)
				                            where o >= coalesce((select o2 from jsonb_array_elements(s.items) with ordinality y(e2,o2) where e2->>'id'=t.items->>'from' limit 1),1)),'[]'::jsonb) end as items
				 from api_turn t join agent_session s on s.id=t.session_id
				 where t.state in ('completed','failed','cancelled')
				   and not exists (select 1 from usage_turn_counted c where c.turn_id=t.id)
				   and ($1::timestamptz is null or t.created_at < $1)
				 order by t.created_at desc limit $2`,
			[cursor, PAGE],
		);
		if (!page.rows.length) break;
		for (const turn of page.rows) {
			seen++;
			if (!apply) continue;
			await recordTurnUsage(
				turn.id,
				turn.model_id,
				turnUsageFact(Array.isArray(turn.items) ? turn.items : []),
				client,
			);
			counted++;
		}
		cursor = page.rows.at(-1)?.created_at ?? null;
	}
	console.log(
		JSON.stringify({ apply, turnsSeen: seen, turnsCounted: counted }),
	);
} finally {
	await client.end();
}
