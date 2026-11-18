/**
 * Read-only egress measurement. Run by the owner against production:
 *
 *   DATABASE_URL=postgres://... pnpm exec tsx scripts/measure-egress-shapes.ts
 *
 * Prints, for each query shape that carries chat transcripts:
 *   1. calls, rows and rows/call from pg_stat_statements (measured);
 *   2. real stored bytes (pg_column_size) of what the shape returns, sampled
 *      per table and per item kind (measured on a sample);
 *   3. estimated bytes = calls x rows/call x sampled bytes/row (estimated;
 *      pg_stat_statements has no byte counts, and the planner's width is
 *      crude for jsonb, so it is not used).
 * Every statement runs in a read-only transaction. Nothing is written.
 */
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Set DATABASE_URL.");

const SAMPLE_PERCENT = Number(process.env.SAMPLE_PERCENT ?? 10);

type Shape = { name: string; like: string[]; notLike?: string[] };

/** The shapes named in docs/database-capacity.md (Egress budget). */
const SHAPES: Shape[] = [
	{
		name: "A. whole chat row, WITH items (select ... items ... from agent_session)",
		like: ["%from agent_session%", "%user_id%", "%briefing%"],
		notLike: [
			"%as items%",
			"%agent_session_item%",
			"%with recursive%",
			"%returning%",
			"%update agent_session%",
		],
	},
	{
		name: "A'. update ... returning the whole chat row (items included)",
		like: ["%agent_session%", "%returning%", "%briefing%"],
		notLike: ["%as items%", "%insert into%"],
	},
	{
		name: "B1. background-command item rows (agent_session_item, kind + background)",
		like: ["%agent_session_item%", "%background%"],
		notLike: ["%update%"],
	},
	{
		name: "B2. every item of a kind of the open chats (agentSessionItemsOfKindsForOwner)",
		like: ["%agent_session_item%", "%i.kind = any(%"],
	},
	{
		name: "C. descendants tree (with recursive descendants)",
		like: ["%with recursive descendants%"],
	},
	{
		name: "D. page reads (with s as ... agent_session_item)",
		like: ["%with s as%", "%agent_session_item%"],
	},
];

const client = new pg.Client({ connectionString: url });

async function rows<T = Record<string, unknown>>(
	sql: string,
	values: unknown[] = [],
) {
	return (await client.query(sql, values)).rows as T[];
}

const fmt = (bytes: number) =>
	bytes >= 1e9
		? `${(bytes / 1e9).toFixed(2)} GB`
		: bytes >= 1e6
			? `${(bytes / 1e6).toFixed(1)} MB`
			: bytes >= 1e3
				? `${(bytes / 1e3).toFixed(1)} KB`
				: `${Math.round(bytes)} B`;

async function main() {
	await client.connect();
	await client.query("begin read only");
	try {
		console.log("== 1. pg_stat_statements (measured calls and rows) ==");
		const statements = new Map<string, { calls: number; rows: number }>();
		for (const shape of SHAPES) {
			const where = [
				...shape.like.map((_, i) => `lower(query) like $${i + 1}`),
				...(shape.notLike ?? []).map(
					(_, i) => `lower(query) not like $${shape.like.length + i + 1}`,
				),
			].join(" and ");
			const found = await rows<{ calls: string; rows: string; query: string }>(
				`select calls::text, rows::text, left(regexp_replace(query,'\\s+',' ','g'),120) as query
				 from pg_stat_statements where ${where} order by rows desc limit 8`,
				[...shape.like, ...(shape.notLike ?? [])].map((p) => p.toLowerCase()),
			);
			const calls = found.reduce((sum, r) => sum + Number(r.calls), 0);
			const total = found.reduce((sum, r) => sum + Number(r.rows), 0);
			statements.set(shape.name, { calls, rows: total });
			console.log(
				`\n${shape.name}\n  calls=${calls} rows=${total} rows/call=${calls ? (total / calls).toFixed(1) : "-"}`,
			);
			for (const r of found)
				console.log(`    ${r.calls} calls, ${r.rows} rows: ${r.query}`);
		}

		console.log(
			`\n== 2. real stored bytes (pg_column_size, ${SAMPLE_PERCENT}% sample) ==`,
		);
		const [sessions] = await rows<Record<string, string>>(
			`select count(*)::text n, avg(pg_column_size(items))::int avg,
			  percentile_disc(0.5) within group (order by pg_column_size(items))::text p50,
			  percentile_disc(0.95) within group (order by pg_column_size(items))::text p95,
			  max(pg_column_size(items))::text max,
			  avg(pg_column_size(a.*) - pg_column_size(items))::int avg_metadata
			 from agent_session a tablesample bernoulli($1)`,
			[SAMPLE_PERCENT],
		);
		console.log("agent_session.items per chat:", sessions);
		const metadataBytes = Number(sessions?.avg_metadata ?? 0);
		const itemsBytes = Number(sessions?.avg ?? 0);

		const kinds = await rows<{
			kind: string;
			n: string;
			avg: string;
			avg_without_output: string;
			avg_without_bulk: string;
		}>(
			`select kind, count(*)::text n, avg(pg_column_size(item))::int::text avg,
			  avg(pg_column_size(item - 'output'))::int::text avg_without_output,
			  avg(pg_column_size(item - array['output','input','html','attachments','memory','contextUsage']))::int::text avg_without_bulk
			 from agent_session_item tablesample bernoulli($1)
			 group by kind order by avg(pg_column_size(item)) * count(*) desc`,
			[SAMPLE_PERCENT],
		);
		console.log("\nagent_session_item per kind (bytes per item):");
		console.table(kinds);

		const [bg] = await rows<Record<string, string>>(
			`select count(*)::text n, avg(pg_column_size(item))::int avg,
			  avg(pg_column_size(item - 'output'))::int avg_without_output,
			  avg(pg_column_size(jsonb_build_object('kind',kind,'background',
			   jsonb_build_object('id',item->'background'->'id','label',item->'background'->'label','startedAt',item->'background'->'startedAt')
			   || case when jsonb_exists(item->'background','exitCode') then jsonb_build_object('exitCode',item->'background'->'exitCode') else '{}'::jsonb end)))::int avg_records
			 from agent_session_item tablesample bernoulli($1)
			 where kind='dynamicToolCall' and item->'background' is not null`,
			[SAMPLE_PERCENT],
		);
		console.log("\nbackground-command items:", bg);

		console.log(
			"\n== 3. estimated bytes over the stats window (calls x rows x bytes/row) ==",
		);
		const a = statements.get(SHAPES[0]?.name ?? "");
		if (a)
			console.log(
				`A. ${a.calls} calls x (${fmt(itemsBytes)} items + ${fmt(metadataBytes)} metadata) ~= ${fmt(a.rows * (itemsBytes + metadataBytes))} (items are TOAST-compressed on disk; the wire carries the text form, typically 2-5x larger: treat this as a LOWER bound)`,
			);
		const b1 = statements.get(SHAPES[2]?.name ?? "");
		if (b1 && bg)
			console.log(
				`B1. ${b1.rows} rows x ${bg.avg} B (full) ~= ${fmt(b1.rows * Number(bg.avg))}; without output ${fmt(b1.rows * Number(bg.avg_without_output))}; records only ${fmt(b1.rows * Number(bg.avg_records))}`,
			);
		const b2 = statements.get(SHAPES[3]?.name ?? "");
		if (b2) {
			const userMessage = kinds.find((k) => k.kind === "userMessage");
			if (userMessage)
				console.log(
					`B2. ${b2.rows} rows x userMessage ${userMessage.avg} B (full) ~= ${fmt(b2.rows * Number(userMessage.avg))}; without bulk keys ${fmt(b2.rows * Number(userMessage.avg_without_bulk))}`,
				);
		}
		console.log(
			"\nNote: C and D must show no items bytes: their column lists exclude `items` (see the regression test).",
		);
	} finally {
		await client.query("rollback");
		await client.end();
	}
}

await main();
