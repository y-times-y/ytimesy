import { createHash } from "node:crypto";

/**
 * Egress visibility: one structured warn line when a single query returns a
 * large result. Sizes are estimated from the rows already parsed (string
 * lengths, a bounded walk of jsonb values, a sample of the rows), never by
 * serializing the result. The tag is a hash plus the first words of the SQL
 * text; values never appear.
 */
export const LARGE_RESULT_BYTES = 100 * 1024;
const SAMPLE_ROWS = 8;
const MAX_NODES_PER_ROW = 20_000;

type Queryable = { query: unknown };
const accountedMarker = Symbol.for("ytimesy.databaseByteAccounting");

export function byteAccountingEnabled(
	environment: Record<string, string | undefined> = process.env,
) {
	if (environment.DATABASE_BYTE_ACCOUNTING === "0") return false;
	if (environment.DATABASE_BYTE_ACCOUNTING === "1") return true;
	return !environment.VITEST;
}

/**
 * A statement names its caller with a leading SQL comment, `/* fn *\/ select
 * ...` (withQueryLabel). The comment travels to the database but is not part
 * of pg_stat_statements' normalised query, so it splits no statistics.
 */
const LABEL_COMMENT = /^\s*\/\*\s*([\w.:-]{1,60})\s*\*\/\s*/;

export function withQueryLabel(label: string, sql: string) {
	return `/* ${label.replace(/[^\w.:-]/g, "_").slice(0, 60)} */ ${sql}`;
}

/** The caller label of a statement, when it has one. */
export function queryLabel(sql: string) {
	return LABEL_COMMENT.exec(sql)?.[1] ?? null;
}

/**
 * `label hash first words` for a labelled statement (the summary's top
 * entries then name functions), `hash first words` otherwise.
 */
export function queryTag(sql: string) {
	const match = LABEL_COMMENT.exec(sql);
	const body = match ? sql.slice(match[0].length) : sql;
	const words = body.trim().replace(/\s+/g, " ").slice(0, 60);
	const hash = createHash("sha1").update(sql).digest("hex").slice(0, 8);
	return match ? `${match[1]} ${hash} ${words}` : `${hash} ${words}`;
}

function valueBytes(value: unknown, budget: { nodes: number }): number {
	if (value === null || value === undefined) return 0;
	if (typeof value === "string") return value.length;
	if (typeof value === "number" || typeof value === "boolean") return 8;
	if (value instanceof Date) return 24;
	if (Buffer.isBuffer(value)) return value.length;
	if (typeof value !== "object") return 0;
	if (budget.nodes-- <= 0) return 0;
	let total = 0;
	if (Array.isArray(value)) {
		for (const item of value) {
			total += valueBytes(item, budget);
			if (budget.nodes <= 0) break;
		}
		return total;
	}
	for (const key in value) {
		total += key.length + valueBytes((value as never)[key], budget);
		if (budget.nodes <= 0) break;
	}
	return total;
}

/** Approximate bytes of a result's rows: sampled rows scaled to the row count. */
export function estimateRowsBytes(rows: unknown) {
	if (!Array.isArray(rows) || rows.length === 0) return 0;
	const count = Math.min(rows.length, SAMPLE_ROWS);
	let sampled = 0;
	for (let index = 0; index < count; index++) {
		const row = rows[Math.floor((index * rows.length) / count)];
		sampled += valueBytes(row, { nodes: MAX_NODES_PER_ROW });
	}
	return Math.round((sampled / count) * rows.length);
}

/**
 * Running per-query-tag totals for this isolate, logged as one
 * `db.egress_summary` line per interval (no timer: checked as queries
 * complete, so an idle isolate logs nothing). Tags are cached by SQL text so
 * the hash is computed once per distinct statement.
 */
export const EGRESS_SUMMARY_INTERVAL_MS = 10 * 60 * 1000;
const TOP_TAGS = 5;
type Totals = { bytes: number; rows: number; calls: number };
const totals = new Map<string, Totals>();
const tagCache = new Map<string, string>();
let windowStartedAt = 0;

function cachedTag(sql: string) {
	let tag = tagCache.get(sql);
	if (tag === undefined) {
		tag = queryTag(sql);
		// Bounded: statements are a fixed set in practice; never grows without limit.
		if (tagCache.size < 2000) tagCache.set(sql, tag);
	}
	return tag;
}

function recordEgress(sql: string, rows: number, bytes: number, now: number) {
	if (!windowStartedAt) windowStartedAt = now;
	const tag = cachedTag(sql);
	const entry = totals.get(tag);
	if (entry) {
		entry.bytes += bytes;
		entry.rows += rows;
		entry.calls += 1;
	} else if (totals.size < 500) totals.set(tag, { bytes, rows, calls: 1 });
	if (now - windowStartedAt < EGRESS_SUMMARY_INTERVAL_MS) return;
	flushEgressSummary(now);
}

/** Logs the running totals as one line and starts a new interval. */
export function flushEgressSummary(now = Date.now()) {
	if (totals.size) {
		let bytes = 0;
		let rows = 0;
		let calls = 0;
		for (const entry of totals.values()) {
			bytes += entry.bytes;
			rows += entry.rows;
			calls += entry.calls;
		}
		const top = [...totals.entries()]
			.sort((a, b) => b[1].bytes - a[1].bytes)
			.slice(0, TOP_TAGS)
			.map(([query, entry]) => ({ query, ...entry }));
		console.info(
			JSON.stringify({
				event: "db.egress_summary",
				windowSeconds: Math.round((now - windowStartedAt) / 1000),
				totalApproxBytes: bytes,
				totalRows: rows,
				totalCalls: calls,
				top,
			}),
		);
	}
	totals.clear();
	windowStartedAt = now;
}

/** Test hook: forget the running totals. */
export function resetEgressSummary() {
	totals.clear();
	tagCache.clear();
	windowStartedAt = 0;
}

function reportLargeResult(sql: string, result: unknown) {
	const rows = (result as { rows?: unknown } | undefined)?.rows;
	const bytes = estimateRowsBytes(rows);
	recordEgress(sql, Array.isArray(rows) ? rows.length : 0, bytes, Date.now());
	if (bytes < LARGE_RESULT_BYTES) return;
	console.warn(
		JSON.stringify({
			event: "db.large_result",
			query: queryTag(sql),
			approxBytes: bytes,
			rows: (rows as unknown[]).length,
		}),
	);
}

function sqlText(first: unknown) {
	if (typeof first === "string") return first;
	const text = (first as { text?: unknown } | null)?.text;
	return typeof text === "string" ? text : "?";
}

function wrapQuery(target: Queryable) {
	if (typeof target.query !== "function") return target;
	const original = (target.query as (...args: unknown[]) => unknown).bind(
		target,
	);
	Object.assign(target, {
		query: (...args: unknown[]) => {
			const outcome = original(...args);
			if (typeof args.at(-1) === "function") return outcome;
			if (!(outcome instanceof Promise)) return outcome;
			const sql = sqlText(args[0]);
			return outcome.then((result) => {
				try {
					reportLargeResult(sql, result);
				} catch {
					// Accounting never fails a query.
				}
				return result;
			});
		},
	});
	return target;
}

/** Wraps pool.query and the clients pool.connect() hands out. Idempotent. */
export function accountQueryBytes<T extends object>(pool: T): T {
	const marked = pool as T & { [accountedMarker]?: true };
	if (marked[accountedMarker]) return pool;
	Object.assign(pool, { [accountedMarker]: true });
	wrapQuery(pool as Queryable);
	const connect = (pool as { connect?: unknown }).connect;
	if (typeof connect === "function") {
		const original = (connect as (...args: unknown[]) => unknown).bind(pool);
		Object.assign(pool, {
			connect: (...args: unknown[]) => {
				const outcome = original(...args);
				if (args.length || !(outcome instanceof Promise)) return outcome;
				return outcome.then((client) => {
					const target = client as Queryable & {
						[accountedMarker]?: true;
					};
					if (!target[accountedMarker]) {
						Object.assign(target, { [accountedMarker]: true });
						wrapQuery(target);
					}
					return client;
				});
			},
		});
	}
	return pool;
}
