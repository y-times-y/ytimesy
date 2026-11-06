import { afterEach, expect, it, vi } from "vitest";
import {
	accountQueryBytes,
	byteAccountingEnabled,
	estimateRowsBytes,
	queryTag,
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
