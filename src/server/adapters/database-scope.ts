import { AsyncLocalStorage } from "node:async_hooks";
import { Pool } from "pg";
import { withInvocationTasks } from "./invocation-tasks";

type DatabaseScope = {
	pool: Pool;
	resources: Map<symbol, Promise<unknown>>;
	cleanup: (() => Promise<void>)[];
};
const scope = new AsyncLocalStorage<DatabaseScope>();

export function scopedDatabase() {
	return scope.getStore()?.pool;
}

/** Typed resource keys are private to their owner; request-owned clients close before their database. */
export function scopedResource<T>(
	key: symbol,
	create: () => Promise<T>,
	dispose: (value: T) => Promise<void>,
): Promise<T> | undefined {
	const current = scope.getStore();
	if (!current) return undefined;
	const existing = current.resources.get(key);
	if (existing) return existing as Promise<T>;
	const ready = create()
		.then((value) => {
			current.cleanup.push(() => dispose(value));
			return value;
		})
		.catch((cause) => {
			current.resources.delete(key);
			throw cause;
		});
	current.resources.set(key, ready);
	return ready;
}

/** Connections belong to one invocation; no Worker socket escapes into another request. */
export async function withDatabaseScope<T>(
	connectionString: string,
	run: () => Promise<T>,
	sslCa: string | null | undefined = process.env.DATABASE_SSL_CA,
) {
	const url = new URL(connectionString);
	if (sslCa) {
		// pg's URL parser overrides explicit TLS options if URL certificate fields remain.
		for (const key of ["sslmode", "sslrootcert", "sslcert", "sslkey"])
			url.searchParams.delete(key);
	}
	const pool = new Pool({
		connectionString: sslCa ? url.href : connectionString,
		...(sslCa ? { ssl: { ca: sslCa, rejectUnauthorized: true } } : {}),
		max: 2,
		connectionTimeoutMillis: 10000,
		statement_timeout: 20000,
		idle_in_transaction_session_timeout: 30000,
	});
	pool.on("error", () => console.warn("Request database connection failed."));
	const current: DatabaseScope = { pool, resources: new Map(), cleanup: [] };
	try {
		return await scope.run(current, () => withInvocationTasks(run));
	} finally {
		for (const close of current.cleanup.reverse())
			await scope
				.run(current, close)
				.catch(() => console.warn("Request resource cleanup failed."));
		await pool.end();
	}
}
