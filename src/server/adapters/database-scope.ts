import { AsyncLocalStorage } from "node:async_hooks";
import { Pool } from "pg";

const scope = new AsyncLocalStorage<Pool>();

export function scopedDatabase() {
	return scope.getStore();
}

/** Connections belong to one invocation; no Worker socket escapes into another request. */
export async function withDatabaseScope<T>(
	connectionString: string,
	run: () => Promise<T>,
) {
	const pool = new Pool({
		connectionString,
		max: 2,
		connectionTimeoutMillis: 10000,
		statement_timeout: 20000,
		idle_in_transaction_session_timeout: 30000,
	});
	pool.on("error", () => console.warn("Request database connection failed."));
	try {
		return await scope.run(pool, run);
	} finally {
		await pool.end();
	}
}
