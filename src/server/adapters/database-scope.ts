import { AsyncLocalStorage } from "node:async_hooks";
import { Pool } from "pg";
import { stepTimingEnabled, timed, timedCall } from "../services/step-timing";
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

/**
 * A read cached across the invocations (Worker requests or durable steps)
 * of an isolate. On Workers, awaiting another request's pending I/O can hang
 * this one for good (that request may end, cancelling it): a pending read is
 * shared only within the invocation that started it, a settled one with any.
 */
export type InvocationSharedRead = {
	readonly owner: object | undefined;
	settled: boolean;
};

export function invocationSharedRead(
	promise: Promise<unknown>,
): InvocationSharedRead {
	const read: InvocationSharedRead = {
		owner: scope.getStore(),
		settled: false,
	};
	const settle = () => {
		read.settled = true;
	};
	promise.then(settle, settle);
	return read;
}

export function usableInThisInvocation(read: InvocationSharedRead) {
	return read.settled || read.owner === scope.getStore();
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
	if (stepTimingEnabled()) timePool(pool);
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

/** Development diagnostics: attributes pooled queries and client checkouts to the current step. */
function timePool(pool: Pool) {
	const query = pool.query.bind(pool) as (...args: unknown[]) => unknown;
	const connect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
	Object.assign(pool, {
		query: (...args: unknown[]) =>
			typeof args.at(-1) === "function"
				? query(...args)
				: timedCall(
						"db:query",
						`sql ${typeof args[0] === "string" ? args[0] : "?"}`,
						() => query(...args) as Promise<unknown>,
					),
		connect: (...args: unknown[]) =>
			args.length
				? connect(...args)
				: timed("db:connect", () => connect() as Promise<unknown>).then(
						(client) => timeClient(client as { query: unknown }),
					),
	});
}

const timedClient = Symbol("timedClient");
/** Checked-out clients (transactions) are listed like pooled queries. */
function timeClient(client: { query: unknown; [timedClient]?: true }) {
	if (client[timedClient]) return client;
	const query = (client.query as (...args: unknown[]) => unknown).bind(client);
	Object.assign(client, {
		[timedClient]: true,
		query: (...args: unknown[]) =>
			typeof args.at(-1) === "function"
				? query(...args)
				: timedCall(
						"db:query",
						`tx ${typeof args[0] === "string" ? args[0] : "?"}`,
						() => query(...args) as Promise<unknown>,
					),
	});
	return client;
}
