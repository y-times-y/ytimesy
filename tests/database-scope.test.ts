import { describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
	pools: [] as { ended: boolean; options: Record<string, unknown> }[],
}));
vi.mock("pg", () => ({
	Pool: class {
		ended = false;
		constructor(readonly options: Record<string, unknown>) {
			fake.pools.push(this);
		}
		on() {}
		async end() {
			this.ended = true;
		}
	},
}));

import {
	scopedDatabase,
	scopedResource,
	withDatabaseScope,
} from "../src/server/adapters/database-scope";

describe("Worker request resources", () => {
	it("shares resources within a request but never across requests; disposes while the pool is scoped", async () => {
		const key = Symbol("test-client");
		const create = vi.fn(async () => ({ id: crypto.randomUUID() }));
		const dispose = vi.fn(async () => {
			expect(scopedDatabase()).toBeDefined();
			expect(fake.pools.at(-1)?.ended).toBe(false);
		});
		const run = () =>
			withDatabaseScope("postgres://test:test@localhost/test", async () => {
				const first = scopedResource(key, create, dispose);
				expect(scopedResource(key, create, dispose)).toBe(first);
				return await first;
			});
		const first = await run();
		const second = await run();
		expect(first).not.toBe(second);
		expect(create).toHaveBeenCalledTimes(2);
		expect(dispose).toHaveBeenCalledTimes(2);
		expect(fake.pools.at(-1)?.ended).toBe(true);
		expect(scopedDatabase()).toBeUndefined();
	});
	it("keeps TLS verification enabled and removes file-based URL overrides", async () => {
		await withDatabaseScope(
			"postgres://test:test@localhost/test?sslmode=verify-full&sslrootcert=/local/cert",
			async () => {},
			"inline-test-ca",
		);
		const options = fake.pools.at(-1)?.options;
		expect(options?.ssl).toEqual({
			ca: "inline-test-ca",
			rejectUnauthorized: true,
		});
		expect(options?.connectionString).not.toContain("sslrootcert");
		expect(options?.connectionString).not.toContain("sslmode");
	});
});
