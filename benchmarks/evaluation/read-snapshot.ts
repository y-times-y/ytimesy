const transientConnectionCodes = new Set([
	"ECONNRESET",
	"ECONNREFUSED",
	"ETIMEDOUT",
	"08006",
	"57P01",
]);

/** Retry observation only: never replay submissions, edits, or grading mutations. */
export async function readEvaluationSnapshot<T>(
	read: () => Promise<T>,
): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await read();
		} catch (error) {
			const connectionFailure =
				error instanceof Error &&
				(transientConnectionCodes.has(
					String((error as Error & { code?: string }).code),
				) ||
					error.message === "Connection terminated unexpectedly");
			if (!connectionFailure || attempt >= 2) throw error;
			await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
		}
	}
}
