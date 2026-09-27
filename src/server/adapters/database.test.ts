import type { PoolConfig } from "pg";
import { afterEach, expect, it, vi } from "vitest";

const pools = vi.hoisted(() => ({ created: 0, options: {} as PoolConfig }));
vi.mock("pg", () => ({
	Pool: class {
		on = vi.fn();
		end = vi.fn(async () => {});
		constructor(options: PoolConfig) {
			pools.created += 1;
			pools.options = options;
		}
	},
}));
vi.mock("../config", () => ({
	serverConfig: () => ({
		DATABASE_URL: "postgres://test",
		DATABASE_POOL_MAX: 2,
	}),
}));
afterEach(() => {
	delete (globalThis as { ytimesyDatabasePool?: unknown }).ytimesyDatabasePool;
	vi.resetModules();
	pools.created = 0;
});

it("bounds connections and wait times and handles idle client failures", async () => {
	const pool = (await import("./database")).database();
	expect(pools.options).toMatchObject({
		max: 2,
		connectionTimeoutMillis: 10000,
		idleTimeoutMillis: 30000,
		maxLifetimeSeconds: 300,
		application_name: "ytimesy",
	});
	expect(pool.on).toHaveBeenCalledWith("error", expect.any(Function));
});

it("closes the shared pool before allowing a fresh one", async () => {
	const { database, closeDatabase } = await import("./database");
	const first = database();
	await closeDatabase();
	expect(first.end).toHaveBeenCalledOnce();
	expect(database()).not.toBe(first);
});

it("reuses the process pool after a server module reload", async () => {
	const first = (await import("./database")).database();
	vi.resetModules();
	const second = (await import("./database")).database();
	expect(second).toBe(first);
	expect(pools.created).toBe(1);
});
