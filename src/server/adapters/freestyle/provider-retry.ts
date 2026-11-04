import { FreestyleApiError } from "freestyle";

/** Backoff for transient provider failures on idempotent machine operations. */
export const TRANSIENT_PROVIDER_RETRY_DELAYS_MS = [1_000, 3_000] as const;

/** What the user sees when the provider stays unreachable after the retries. */
export const PROVIDER_UNAVAILABLE_MESSAGE =
	"The workspace machine is not responding. Try again in a minute.";

/** Connection-level failures (undici, Workers) that never reached an answer. */
const NETWORK_FAILURE =
	/\b(fetch failed|network connection lost|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|UND_ERR_SOCKET|socket hang up|other side closed)\b/i;

/**
 * A failure worth one more try: a provider 5xx (or a timeout it or this
 * client answered with), or a connection that failed before any answer.
 * Possibly wrapped: Effect's UnknownException keeps it as `cause`/`error`.
 * A caller's abort is not one.
 */
export function isTransientProviderFailure(error: unknown, depth = 0): boolean {
	if (depth > 3 || !error || typeof error !== "object") return false;
	if (error instanceof FreestyleApiError)
		return (
			(error.status >= 500 && error.status < 600) ||
			error.status === 408 ||
			(error.code === "UNKNOWN_ERROR" && /request timeout/i.test(error.message))
		);
	if (
		error instanceof Error &&
		error.name === "FreestyleApiError" &&
		/internal server error|request timeout/i.test(error.message)
	)
		return true;
	if (
		error instanceof Error &&
		error.name !== "AbortError" &&
		NETWORK_FAILURE.test(error.message)
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
 * named VM, a slug-keyed create that recovers an existing VM, a file write,
 * a harmless probe) when the provider fails transiently. Anything else, or a
 * persistent failure, propagates unchanged. Never wrap a user's command.
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
			console.warn("Machine provider failed transiently; retrying.", {
				attempt: attempt + 1,
			});
			await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
		}
	}
}

/** Cloudflare's wording when a Durable Object is reset for a new version mid-operation. */
const PLATFORM_RESTART =
	/Durable Object reset because|Durable Object's code has been updated|its code was updated|code was updated, this version can no longer/i;

/**
 * The failure is this Worker being replaced by a new version (a deploy or a
 * secret change), not the operation's own: the step must be resumed on the
 * new version, never settled as failed.
 */
export function isPlatformRestart(error: unknown, depth = 0): boolean {
	if (depth > 5 || !error || typeof error !== "object") return false;
	if (error instanceof Error && PLATFORM_RESTART.test(error.message))
		return true;
	const record = error as {
		cause?: unknown;
		error?: unknown;
		providerError?: unknown;
		lastError?: unknown;
	};
	return [
		record.cause,
		record.error,
		record.providerError,
		record.lastError,
	].some((inner) => isPlatformRestart(inner, depth + 1));
}

/**
 * The Workers runtime's own answers while a deploy swaps versions (or an
 * isolate is recycled): "internal error; reference = …", a lost connection
 * to another Worker or Durable Object, a Durable Object reset for new code.
 */
const RUNTIME_BLIP =
	/internal error; reference =|network connection lost|Worker (was|has been) restarted|transient issue on remote node/i;

/**
 * The failure is the platform's, not the code's: retrying on the next run
 * succeeds unless something is really broken. When several failures were
 * collected (`errors`, as MaintenanceStepsFailed and AggregateError keep
 * them), every one must be such a blip.
 */
export function isWorkersRuntimeBlip(error: unknown, depth = 0): boolean {
	if (depth > 5 || !error || typeof error !== "object") return false;
	const record = error as { errors?: unknown; cause?: unknown };
	if (Array.isArray(record.errors) && record.errors.length)
		return record.errors.every((inner) =>
			isWorkersRuntimeBlip(inner, depth + 1),
		);
	if (isPlatformRestart(error)) return true;
	if (error instanceof Error && RUNTIME_BLIP.test(error.message)) return true;
	return isWorkersRuntimeBlip(record.cause, depth + 1);
}
