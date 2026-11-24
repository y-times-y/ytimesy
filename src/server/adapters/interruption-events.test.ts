import { beforeEach, expect, it, vi } from "vitest";

vi.mock("./database", () => ({
	database: () => ({ query: async () => ({ rows: [] }) }),
}));

import {
	recordInterruption,
	resetInterruptionLimiter,
} from "./interruption-events";

beforeEach(() => {
	resetInterruptionLimiter();
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

it("writes one row and rate limits the same kind and turn in memory", async () => {
	const query = vi.fn(async () => ({ rowCount: 1 }));
	const event = { kind: "turn.interrupted", turnId: "t1", cause: "reset" };
	expect(await recordInterruption(event, { query, now: () => 1000 })).toBe(
		"recorded",
	);
	expect(await recordInterruption(event, { query, now: () => 2000 })).toBe(
		"limited",
	);
	expect(query).toHaveBeenCalledTimes(1);
	expect(
		await recordInterruption(
			{ ...event, turnId: "t2" },
			{ query, now: () => 2000 },
		),
	).toBe("recorded");
	expect(
		await recordInterruption(event, { query, now: () => 1000 + 11 * 60_000 }),
	).toBe("recorded");
});

it("reports limited when the database already holds a recent row", async () => {
	const query = vi.fn(async () => ({ rowCount: 0 }));
	expect(await recordInterruption({ kind: "k", turnId: "t" }, { query })).toBe(
		"limited",
	);
});

it("never throws: a failing or hanging database is 'failed'", async () => {
	const boom = async () => {
		throw new Error("db down");
	};
	expect(
		await recordInterruption({ kind: "k", turnId: "a" }, { query: boom }),
	).toBe("failed");
	const hang = () => new Promise<never>(() => {});
	const started = Date.now();
	expect(
		await recordInterruption(
			{ kind: "k", turnId: "b" },
			{ query: hang, timeoutMs: 20 },
		),
	).toBe("failed");
	expect(Date.now() - started).toBeLessThan(1000);
	const sync = () => {
		throw new Error("sync");
	};
	expect(
		await recordInterruption(
			{ kind: "k", turnId: "c" },
			{ query: sync as never },
		),
	).toBe("failed");
});

it("truncates oversized fields", async () => {
	const query = vi.fn(async (_sql: string, _values: unknown[]) => ({
		rowCount: 1,
	}));
	await recordInterruption(
		{ kind: "k".repeat(200), turnId: "t", cause: "c".repeat(500) },
		{ query },
	);
	const values = query.mock.calls[0]?.[1] as string[];
	expect(values[0]).toHaveLength(60);
	expect(values[3]).toHaveLength(120);
});
