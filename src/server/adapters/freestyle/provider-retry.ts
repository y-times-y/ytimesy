import { FreestyleApiError } from "freestyle";

/** Backoff for provider 5xx answers ("Internal server error") on idempotent machine operations. */
export const TRANSIENT_PROVIDER_RETRY_DELAYS_MS = [1_000, 3_000] as const;

/** A provider 5xx, possibly wrapped (Effect's UnknownException keeps it as `cause`/`error`). */
export function isTransientProviderFailure(error: unknown, depth = 0): boolean {
	if (depth > 3 || !error || typeof error !== "object") return false;
	if (error instanceof FreestyleApiError)
		return error.status >= 500 && error.status < 600;
	if (
		error instanceof Error &&
		error.name === "FreestyleApiError" &&
		/internal server error/i.test(error.message)
	)
		return true;
	const record = error as { cause?: unknown; error?: unknown };
	return (
		isTransientProviderFailure(record.cause, depth + 1) ||
		isTransientProviderFailure(record.error, depth + 1)
	);
}

/**
 * Retries an operation the caller has made safe to repeat (start/resume of a
 * named VM, or a slug-keyed create that recovers an existing VM) when the
 * provider answers with a transient 5xx. Anything else, or a persistent 5xx,
 * propagates unchanged.
 */
export async function retryTransientProviderFailure<T>(
	operation: () => Promise<T>,
	delaysMs: readonly number[] = TRANSIENT_PROVIDER_RETRY_DELAYS_MS,
): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await operation();
		} catch (error) {
			if (attempt >= delaysMs.length || !isTransientProviderFailure(error))
				throw error;
			console.warn("Machine provider returned a transient error; retrying.", {
				attempt: attempt + 1,
			});
			await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
		}
	}
}
