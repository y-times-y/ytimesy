/**
 * Read-only database budget report: size, biggest tables with dead tuples,
 * and the heaviest queries by calls and by rows (pg_stat_statements).
 * Prints counts and normalized query text only, never values.
 * docs/database-budget.md says how to read it.
 *
 *   node --env-file=.env --import tsx scripts/db-budget-report.ts
 *
 * Inputs: DB_REPORT_DATABASE_URL, else DATABASE_URL. SUPABASE_CA_PATH (a file)
 * when the server certificate needs a CA. Exit code 1 on WARN (for CI).
 */
import { readFileSync } from "node:fs";
import { Client } from "pg";

/**
 * Our own alarm lines, not Supabase plan numbers. Compare the database size
 * and egress with the limits on the Supabase plan (Dashboard, Usage) and lower
 * these if the plan is smaller. Environment variables override them.
 */
const THRESHOLDS = {
	databaseBytes: Number(process.env.BUDGET_DATABASE_BYTES ?? 2 * 1024 ** 3),
	tableBytes: Number(process.env.BUDGET_TABLE_BYTES ?? 512 * 1024 ** 2),
	deadTupleRatio: 0.2,
	deadTupleMinimum: 10_000,
	/** Rows returned by one normalized query since the last stats reset. */
	queryRows: Number(process.env.BUDGET_QUERY_ROWS ?? 5_000_000),
	/** Calls of one normalized query since the last stats reset. */
	queryCalls: Number(process.env.BUDGET_QUERY_CALLS ?? 2_000_000),
};
const TOP = 10;

const warnings: string[] = [];
const warn = (message: string) => warnings.push(message);

const megabytes = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(1)} MB`;
const oneLine = (sql: string) => sql.replace(/\s+/g, " ").trim().slice(0, 160);

function connect() {
	const connectionString =
		process.env.DB_REPORT_DATABASE_URL ?? process.env.DATABASE_URL;
	if (!connectionString)
		throw new Error("Set DB_REPORT_DATABASE_URL or DATABASE_URL.");
	const caPath = process.env.SUPABASE_CA_PATH;
	const url = new URL(connectionString);
	if (caPath)
		for (const key of ["sslmode", "sslrootcert", "sslcert", "sslkey"])
			url.searchParams.delete(key);
	return new Client({
		connectionString: caPath ? url.href : connectionString,
		...(caPath
			? { ssl: { ca: readFileSync(caPath, "utf8"), rejectUnauthorized: true } }
			: {}),
		application_name: "ytimesy-db-budget-report",
		statement_timeout: 30_000,
	});
}

async function main() {
	const client = connect();
	await client.connect();
	try {
		await client.query("set default_transaction_read_only = on");
		await report(client);
	} finally {
		await client.end();
	}
	console.log("");
	if (warnings.length) {
		console.log(`WARN (${warnings.length})`);
		for (const message of warnings) console.log(`- ${message}`);
		process.exitCode = 1;
	} else console.log("PASS");
}

async function report(client: Client) {
	const size = await client.query<{ bytes: string }>(
		"select pg_database_size(current_database()) as bytes",
	);
	const databaseBytes = Number(size.rows[0]?.bytes ?? 0);
	console.log(`Database size: ${megabytes(databaseBytes)}`);
	if (databaseBytes > THRESHOLDS.databaseBytes)
		warn(
			`database is ${megabytes(databaseBytes)}, over ${megabytes(THRESHOLDS.databaseBytes)}`,
		);

	const tables = await client.query<{
		name: string;
		total: string;
		live: string;
		dead: string;
	}>(
		`select schemaname || '.' || relname as name,
		        pg_total_relation_size(relid) as total,
		        n_live_tup as live, n_dead_tup as dead
		   from pg_stat_user_tables
		  order by pg_total_relation_size(relid) desc limit $1`,
		[TOP],
	);
	console.log(`\nTop ${TOP} tables by total size (with indexes and toast)`);
	for (const row of tables.rows) {
		const total = Number(row.total);
		const live = Number(row.live);
		const dead = Number(row.dead);
		console.log(
			`  ${row.name.padEnd(44)} ${megabytes(total).padStart(11)}  live ${live}  dead ${dead}`,
		);
		if (total > THRESHOLDS.tableBytes)
			warn(`table ${row.name} is ${megabytes(total)}`);
		if (
			dead > THRESHOLDS.deadTupleMinimum &&
			dead / Math.max(1, live + dead) > THRESHOLDS.deadTupleRatio
		)
			warn(`table ${row.name} has ${dead} dead tuples against ${live} live`);
	}

	const extension = await client.query(
		"select 1 from pg_extension where extname = 'pg_stat_statements'",
	);
	if (!extension.rowCount) {
		console.log("\npg_stat_statements is not enabled: no query statistics.");
		warn("pg_stat_statements is not enabled, so query volume is not visible");
		return;
	}
	for (const [label, column, limit] of [
		["calls", "calls", THRESHOLDS.queryCalls],
		["rows returned", "rows", THRESHOLDS.queryRows],
	] as const) {
		const statements = await client.query<{
			query: string;
			calls: string;
			rows: string;
			mean_ms: number;
		}>(
			`select query, calls, rows, mean_exec_time as mean_ms
			   from pg_stat_statements
			  where dbid = (select oid from pg_database where datname = current_database())
			    and query not ilike '%pg_stat_statements%'
			  order by ${column} desc limit $1`,
			[TOP],
		);
		console.log(`\nTop ${TOP} queries by ${label} since the last stats reset`);
		for (const row of statements.rows) {
			console.log(
				`  calls ${row.calls}  rows ${row.rows}  mean ${Number(row.mean_ms).toFixed(1)} ms  ${oneLine(row.query)}`,
			);
			if (Number(row[column]) > limit)
				warn(
					`query with ${row[column]} ${label}, over ${limit}: ${oneLine(row.query).slice(0, 100)}`,
				);
		}
	}
}

await main().catch((cause) => {
	console.error(
		`Report failed: ${cause instanceof Error ? cause.message : "unknown error"}`,
	);
	process.exitCode = 2;
});
