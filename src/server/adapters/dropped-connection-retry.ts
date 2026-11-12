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
