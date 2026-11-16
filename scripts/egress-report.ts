/**
 * Database egress report, read-only: which queries move the most data out of
 * Postgres, from the app's own `db.large_result` log lines (queries returning
 * 100 KB or more; see docs/database-budget.md), and where that rate leads.
 *
 *   node --import tsx scripts/egress-report.ts [hours]      (default 24)
 *
 * Needs CLOUDFLARE_OBSERVABILITY_API_TOKEN (or CLOUDFLARE_API_TOKEN) to read
 * Workers Observability. EGRESS_QUOTA_GB is the plan's monthly egress (250 on
 * Supabase Pro); EGRESS_WARN_PERCENT (default 50) is the projected share of it
 * that makes this exit 1, so a scheduled run can alert.
 *
 * Reads under 100 KB are not logged, so this slightly under-counts. On
 * 2026-11-11 its 24 h total (4.2 GB) was close to Supabase's own chart for the
 * day (3.9 GB), so treat it as a good proxy and Supabase's chart as the truth.
 * Query tags are hashes of the SQL (never values): `0c98672b with claimed as ...`.
 */
export {};

const token =
	process.env.CLOUDFLARE_OBSERVABILITY_API_TOKEN ??
	process.env.CLOUDFLARE_API_TOKEN;
if (!token) throw new Error("Set CLOUDFLARE_OBSERVABILITY_API_TOKEN.");
const hours = Number(process.argv[2] ?? 24);
if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 14)
	throw new Error("Hours must be between 0 and 336.");
const quotaGb = Number(process.env.EGRESS_QUOTA_GB ?? 250);
const warnPercent = Number(process.env.EGRESS_WARN_PERCENT ?? 50);
const api = "https://api.cloudflare.com/client/v4";
const headers = {
	authorization: `Bearer ${token}`,
	"content-type": "application/json",
};

async function json<T>(url: string, init?: RequestInit): Promise<T> {
	const response = await fetch(url, {
		...init,
		headers,
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) throw new Error(`Cloudflare answered ${response.status}.`);
	return (await response.json()) as T;
}

const accounts = await json<{ result?: { id: string }[] }>(`${api}/accounts`);
const account = accounts.result?.[0]?.id as string | undefined;
if (!account)
	throw new Error("No Cloudflare account is visible to this token.");

const now = Date.now();
const result = await json<{
	result?: {
		calculations?: {
			alias: string;
			aggregates?: { value: number; groups?: { value: string }[] }[];
		}[];
	};
}>(`${api}/accounts/${account}/workers/observability/telemetry/query`, {
	method: "POST",
	body: JSON.stringify({
		queryId: "egress-report",
		timeframe: { from: now - hours * 3_600_000, to: now },
		view: "calculations",
		parameters: {
			datasets: [],
			filters: [
				{
					key: "event",
					operation: "eq",
					type: "string",
					value: "db.large_result",
				},
			],
			calculations: [
				{
					operator: "sum",
					key: "approxBytes",
					keyType: "number",
					alias: "bytes",
				},
				{ operator: "count", alias: "calls" },
			],
			groupBys: [
				{ type: "string", value: "query" },
				{ type: "string", value: "$metadata.service" },
			],
			orderBy: { value: "bytes", order: "desc" },
			limit: 15,
		},
	}),
});

type Row = { bytes: number; calls: number };
const rows = new Map<string, Row>();
for (const calculation of result.result?.calculations ?? [])
	for (const aggregate of calculation.aggregates ?? []) {
		const key = `${String(aggregate.groups?.[1]?.value ?? "?").replace(/^ytimesy-|-production$/g, "")}  ${String(aggregate.groups?.[0]?.value ?? "?").slice(0, 70)}`;
		const row = rows.get(key) ?? { bytes: 0, calls: 0 };
		row[calculation.alias === "calls" ? "calls" : "bytes"] = Number(
			aggregate.value,
		);
		rows.set(key, row);
	}

// The ranked query is limited to 15 groups; its sum is not the account total.
const totals = await json<{
	result?: {
		calculations?: { alias: string; aggregates?: { value: number }[] }[];
	};
}>(`${api}/accounts/${account}/workers/observability/telemetry/query`, {
	method: "POST",
	body: JSON.stringify({
		queryId: "egress-report-total",
		timeframe: { from: now - hours * 3_600_000, to: now },
		view: "calculations",
		parameters: {
			datasets: [],
			filters: [
				{
					key: "event",
					operation: "eq",
					type: "string",
					value: "db.large_result",
				},
			],
			calculations: [
				{
					operator: "sum",
					key: "approxBytes",
					keyType: "number",
					alias: "bytes",
				},
			],
		},
	}),
});
const bytesCalculation = totals.result?.calculations?.find(
	(calculation) => calculation.alias === "bytes",
);
if (!bytesCalculation?.aggregates)
	throw new Error(
		"Cloudflare did not return the large-read total; usage is unknown.",
	);
const total = bytesCalculation.aggregates.reduce((sum, aggregate) => {
	const value = Number(aggregate.value);
	if (!Number.isFinite(value) || value < 0)
		throw new Error("Cloudflare returned an invalid large-read total.");
	return sum + value;
}, 0);
const rankedTotal = [...rows.values()].reduce((sum, row) => sum + row.bytes, 0);
const gb = (bytes: number) => (bytes / 1e9).toFixed(2);
console.log(
	`Top 15 groups of large database reads, last ${hours} h (queries of 100 KB or more)`,
);
console.log(
	`Listed groups cover ${total ? ((100 * rankedTotal) / total).toFixed(1) : "0.0"}% of all logged large-read bytes. This is estimated result size, not total provider egress.`,
);
for (const [key, row] of [...rows].sort((a, b) => b[1].bytes - a[1].bytes))
	console.log(
		`  ${(row.bytes / 1e6).toFixed(0).padStart(7)} MB  ${String(row.calls).padStart(6)} calls  ${((100 * row.bytes) / (total || 1)).toFixed(0).padStart(3)}%  ${key}`,
	);
const perDay = (total / hours) * 24;
const projected = (perDay * 30) / 1e9;
const percent = (100 * projected) / quotaGb;
console.log(
	`\nTotal ${gb(total)} GB, which is ${gb(perDay)} GB/day and about ${projected.toFixed(0)} GB per 30 days: ${percent.toFixed(0)}% of the ${quotaGb} GB plan.`,
);
if (percent >= warnPercent) {
	console.log(
		`WARN: projected egress is at or above ${warnPercent}% of the plan. Look at the top queries above.`,
	);
	process.exitCode = 1;
} else console.log("PASS");
