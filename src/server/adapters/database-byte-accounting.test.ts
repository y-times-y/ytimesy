import { afterEach, expect, it, vi } from "vitest";
import {
	accountQueryBytes,
	byteAccountingEnabled,
	estimateRowsBytes,
	queryLabel,
	queryTag,
	withQueryLabel,
} from "./database-byte-accounting";

afterEach(() => vi.restoreAllMocks());

function fakePool(rows: unknown[]) {
	return {
		query: vi.fn(async (..._args: unknown[]) => ({ rows })),
		connect: vi.fn(async () => ({
			query: vi.fn(async (..._args: unknown[]) => ({ rows })),
		})),
	};
}

it("warns once with a value-free tag when a result is large", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const pool = accountQueryBytes(
		fakePool([{ id: 1, transcript: { messages: ["x".repeat(300_000)] } }]),
	);
	await pool.query("select transcript from chats where id = $1", ["secret"]);
	expect(warn).toHaveBeenCalledTimes(1);
	const line = JSON.parse(warn.mock.calls[0]?.[0] as string);
	expect(line.event).toBe("db.large_result");
	expect(line.approxBytes).toBeGreaterThan(300_000);
	expect(line.query).toContain("select transcript from chats");
	expect(JSON.stringify(line)).not.toContain("secret");
});

it("stays quiet for small results and covers checked-out clients", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const small = accountQueryBytes(fakePool([{ id: 1, name: "a" }]));
	await small.query("select 1");
	expect(warn).not.toHaveBeenCalled();
	const big = accountQueryBytes(fakePool([{ body: "y".repeat(200_000) }]));
	const client = await big.connect();
	await client.query({ text: "select body from t" });
	expect(warn).toHaveBeenCalledTimes(1);
});

it("is idempotent and passes results through untouched", async () => {
	const rows = [{ a: 1 }];
	const pool = fakePool(rows);
	accountQueryBytes(pool);
	const wrapped = pool.query;
	accountQueryBytes(pool);
	expect(pool.query).toBe(wrapped);
	expect(await pool.query()).toEqual({ rows });
});

it("estimates by sampling without walking every row", () => {
	const rows = Array.from({ length: 1000 }, () => ({ v: "z".repeat(1000) }));
	expect(estimateRowsBytes(rows)).toBeGreaterThan(1_000_000);
	expect(estimateRowsBytes([])).toBe(0);
});

it("tags queries by hash and first words", () => {
	expect(queryTag("select  a\n from b")).toMatch(
		/^[0-9a-f]{8} select a from b/,
	);
});

it("is off under tests unless asked", () => {
	expect(byteAccountingEnabled({ VITEST: "true" })).toBe(false);
	expect(
		byteAccountingEnabled({ VITEST: "true", DATABASE_BYTE_ACCOUNTING: "1" }),
	).toBe(true);
	expect(byteAccountingEnabled({})).toBe(true);
});

it("logs one egress summary per interval with the top tags by bytes, and no per-query lines", async () => {
	const { EGRESS_SUMMARY_INTERVAL_MS, resetEgressSummary } = await import(
		"./database-byte-accounting"
	);
	resetEgressSummary();
	vi.useFakeTimers();
	try {
		vi.setSystemTime(new Date("2026-11-18T00:00:00Z"));
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const rowsFor = (n: number, size: number) =>
			Array.from({ length: n }, () => ({ v: "z".repeat(size) }));
		let next: unknown[] = [];
		const pool = accountQueryBytes({
			query: async (..._args: unknown[]) => ({ rows: next }),
		});
		const run = (sql: string, rows: unknown[]) => {
			next = rows;
			return pool.query(sql, ["secret"]);
		};
		for (let tag = 0; tag < 7; tag++)
			for (let call = 0; call < 3; call++)
				await run(`select c${tag} from t${tag}`, rowsFor(tag + 1, 100));
		expect(info).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
		vi.setSystemTime(Date.now() + EGRESS_SUMMARY_INTERVAL_MS + 1);
		await run("select c0 from t0", rowsFor(1, 100));
		expect(info).toHaveBeenCalledTimes(1);
		const line = JSON.parse(info.mock.calls[0]?.[0] as string);
		expect(line.event).toBe("db.egress_summary");
		expect(line.top).toHaveLength(5);
		expect(line.top[0].query).toContain("select c6 from t6");
		expect(line.top[0]).toMatchObject({ rows: 21, calls: 3 });
		expect(line.totalCalls).toBe(22);
		expect(line.totalRows).toBe(3 * (1 + 2 + 3 + 4 + 5 + 6 + 7) + 1);
		expect(JSON.stringify(line)).not.toContain("secret");
		// Totals restart: a call right after logs nothing.
		await run("select c0 from t0", rowsFor(1, 100));
		expect(info).toHaveBeenCalledTimes(1);
	} finally {
		vi.useRealTimers();
		resetEgressSummary();
	}
});

it("names a labelled statement's caller in its tag, and leaves other tags as they were", () => {
	const labelled = withQueryLabel("agentSessionForOwner", "select 1");
	expect(labelled).toBe("/* agentSessionForOwner */ select 1");
	expect(queryLabel(labelled)).toBe("agentSessionForOwner");
	expect(queryTag(labelled)).toMatch(
		/^agentSessionForOwner [0-9a-f]{8} select 1$/,
	);
	expect(queryLabel("select 1")).toBeNull();
	expect(queryTag("select 1")).toMatch(/^[0-9a-f]{8} select 1$/);
	// A label cannot smuggle SQL into the comment.
	expect(withQueryLabel("a */ drop table x; /*", "select 1")).not.toContain(
		"*/ drop",
	);
});
