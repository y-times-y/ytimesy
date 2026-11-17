import type { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";

const pools = vi.hoisted(() => ({ made: [] as unknown[] }));
vi.mock("pg", async () => {
	const { EventEmitter } = await import("node:events");
	class Pool extends EventEmitter {
		totalCount = 2;
		idleCount = 0;
		waitingCount = 1;
		failures = 2;
		calls = 0;
		constructor() {
			super();
			pools.made.push(this);
		}
		async query() {
			this.calls++;
			if (this.failures-- > 0)
				throw new Error("timeout exceeded when trying to connect");
			return { rows: [{ ok: 1 }] };
		}
		async connect() {
			return { query: this.query, release() {} };
		}
		async end() {}
	}
	return { Pool };
});

import { database } from "./database";
import { withDatabaseScope } from "./database-scope";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

it("repeats a pool connect timeout and logs stage, cause and pool counts; an errored client logs the same fields", async () => {
	vi.useFakeTimers();
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const run = withDatabaseScope("postgres://u:p@localhost/db", async () => {
		const pending = database().query("select 1");
		await vi.advanceTimersByTimeAsync(1000);
		const result = await pending;
		(pools.made[0] as EventEmitter).emit(
			"error",
			Object.assign(new Error("Connection terminated unexpectedly"), {
				code: "ECONNRESET",
			}),
		);
		return result;
	});
	await expect(run).resolves.toMatchObject({ rows: [{ ok: 1 }] });
	expect(warn).toHaveBeenCalledWith("Request database connection failed.", {
		stage: "query",
		code: null,
		message: "timeout exceeded when trying to connect",
		attempt: 1,
		total: 2,
		idle: 0,
		waiting: 1,
	});
	expect(warn).toHaveBeenCalledWith("Request database connection failed.", {
		stage: "client-error",
		code: "ECONNRESET",
		message: "Connection terminated unexpectedly",
		attempt: 0,
		total: 2,
		idle: 0,
		waiting: 1,
	});
});
