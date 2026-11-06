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

export function queryTag(sql: string) {
	const words = sql.trim().replace(/\s+/g, " ").slice(0, 60);
	const hash = createHash("sha1").update(sql).digest("hex").slice(0, 8);
	return `${hash} ${words}`;
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

function reportLargeResult(sql: string, result: unknown) {
	const rows = (result as { rows?: unknown } | undefined)?.rows;
	const bytes = estimateRowsBytes(rows);
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
