import { isConnectFailure } from "#/domain/database-connection-failure";

/**
 * A database connection that dropped mid-statement ("Connection terminated
 * unexpectedly", a reset socket) says nothing about the statement. The turn's
 * own writes are fenced by the lease and set the same content when repeated,
 * so one more try is safe and costs a quarter second; failing the whole turn
 * for a dropped connection (Nov 11: "Turn progress could not be saved") cost
 * the user the run.
 */
const DROPPED =
	/\b(connection terminated|ECONNRESET|EPIPE|connection (?:was )?closed|socket hang up)\b/i;

export function isDroppedConnection(error: unknown) {
	if (typeof error !== "object" || error === null) return false;
	const { code, message } = error as { code?: unknown; message?: unknown };
	return (
		["ECONNRESET", "EPIPE", "08006", "57P01"].includes(String(code)) ||
		(typeof message === "string" && DROPPED.test(message))
	);
}

export async function retryDroppedConnection<T>(
	run: () => Promise<T>,
	options: { retries?: number; delayMs?: number } = {},
): Promise<T> {
	const retries = options.retries ?? 2;
	for (let attempt = 0; ; attempt++) {
		try {
			return await run();
		} catch (error) {
			if (attempt >= retries || !isDroppedConnection(error)) throw error;
			console.warn("Database connection dropped; repeating the write.", {
				attempt: attempt + 1,
			});
			await new Promise((resolve) =>
				setTimeout(resolve, (options.delayMs ?? 250) * (attempt + 1)),
			);
		}
	}
}

export { isConnectFailure };

/** Backoff before the first and second repeat of a send's connection (ms). */
export const CONNECT_RETRY_DELAYS_MS = [250, 750] as const;

/** The pool state a failure log carries: connections open, idle, and callers waiting. */
export type PoolStats = {
	readonly total: number;
	readonly idle: number;
	readonly waiting: number;
};

export function poolStats(pool: {
	totalCount: number;
	idleCount: number;
	waitingCount: number;
}): PoolStats {
	return {
		total: pool.totalCount,
		idle: pool.idleCount,
		waiting: pool.waitingCount,
	};
}

/**
 * One structured warning per connection failure. The message only (a pg
 * connection error never carries SQL, parameters or user content; it is cut
 * short regardless).
 */
export function logConnectionFailure(
	stage: string,
	error: unknown,
	attempt: number,
	stats: PoolStats | null,
) {
	const { code, message } = (
		typeof error === "object" && error !== null ? error : {}
	) as { code?: unknown; message?: unknown };
	console.warn("Request database connection failed.", {
		stage,
		code: typeof code === "string" ? code : null,
		message: typeof message === "string" ? message.slice(0, 200) : "unknown",
		attempt,
		...(stats ?? {}),
	});
}

/**
 * Repeats `run` while it fails with a connection that could not be had (a
 * failure before any statement ran) up to the backoff list's length.
 */
export async function retryConnectFailure<T>(
	run: () => Promise<T>,
	options: {
		stage: string;
		stats?: () => PoolStats | null;
		delaysMs?: readonly number[];
	},
): Promise<T> {
	const delays = options.delaysMs ?? CONNECT_RETRY_DELAYS_MS;
	for (let attempt = 1; ; attempt++) {
		try {
			return await run();
		} catch (error) {
			if (!isConnectFailure(error)) throw error;
			logConnectionFailure(
				options.stage,
				error,
				attempt,
				options.stats?.() ?? null,
			);
			const delay = delays[attempt - 1];
			if (delay === undefined) throw error;
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}
}
