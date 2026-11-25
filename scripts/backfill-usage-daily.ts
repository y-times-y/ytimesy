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
const PAGE = 100;
const client = new pg.Client({
	connectionString: url
		.replace(/[?&]sslrootcert=[^&]*/, "")
		.replace(/[?&]sslmode=[^&]*/, ""),
	ssl: { ca: supabaseCertificate(process.env), rejectUnauthorized: true },
});
await client.connect();
try {
	await client.query("set statement_timeout='60s'");
	let cursor: string | null = null;
	let counted = 0;
	let seen = 0;
	for (;;) {
		// Page by created_at (cheap), then read only each turn's small usage object.
		const page: {
			rows: { id: string; model_id: string; created_at: string }[];
		} = await client.query(
			`select id,model_id,created_at::text from api_turn
			 where state in ('completed','failed','cancelled')
			   and ($1::timestamptz is null or created_at < $1)
			 order by created_at desc limit $2`,
			[cursor, PAGE],
		);
		if (!page.rows.length) break;
		const ids = page.rows.map((turn) => turn.id);
		// A turn's items are its own array (older rows) or {"from": id} into the chat's items (newer rows).
		const usage: { rows: { id: string; usage: unknown }[] } =
			await client.query(
				`select t.id,(
				   select x.e->'apiUsage' from jsonb_array_elements(
				     case when jsonb_typeof(t.items)='array' then t.items else s.items end
				   ) with ordinality x(e,o)
				   where x.e->>'kind'='userMessage'
				     and (jsonb_typeof(t.items)='array' or x.o >= coalesce(
				       (select y.o from jsonb_array_elements(s.items) with ordinality y(e,o) where y.e->>'id'=t.items->>'from' limit 1),1))
				   order by x.o desc limit 1) as usage
				 from api_turn t join agent_session s on s.id=t.session_id
				 where t.id = any($1::uuid[]) and not exists (select 1 from usage_turn_counted c where c.turn_id=t.id)`,
				[ids],
			);
		const byId = new Map(usage.rows.map((row) => [row.id, row.usage]));
		for (const turn of page.rows) {
			if (!byId.has(turn.id)) continue;
			seen++;
			if (!apply) continue;
			const apiUsage = byId.get(turn.id);
			await recordTurnUsage(
				turn.id,
				turn.model_id,
				turnUsageFact(
					apiUsage
						? ([{ kind: "userMessage", id: "u", text: "", apiUsage }] as never)
						: [],
				),
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
