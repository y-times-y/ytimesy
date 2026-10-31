export async function requestJson<T>(path: string, body?: unknown): Promise<T> {
	const response = await fetch(path, {
		method: body === undefined ? "GET" : "POST",
		headers:
			body === undefined ? undefined : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	if (!response.ok) {
		const text = await response.text();
		let message = text;
		try {
			message = JSON.parse(text).error ?? text;
		} catch {}
		throw new HttpRequestError(message || "Request failed.", response.status);
	}
	return response.json();
}
export class HttpRequestError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "HttpRequestError";
	}
}

const UNREACHABLE_READ =
	/failed to fetch|networkerror|load failed|network request failed/i;

/**
 * The browser never got an HTTP response. Safari reports that as
 * TypeError "Load failed"; an aborted navigation is AbortError.
 * An HttpRequestError is a real response and is not unreachable.
 */
export function isUnreachableRead(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	if (error instanceof HttpRequestError) return false;
	if (error instanceof TypeError) return true;
	if ("name" in error && error.name === "AbortError") return true;
	const message =
		"message" in error && typeof error.message === "string"
			? error.message
			: "";
	return UNREACHABLE_READ.test(message);
}

export function retryTransientRead(failureCount: number, error: Error) {
	if (failureCount >= 2) return false;
	if (error instanceof HttpRequestError)
		return error.status === 408 || error.status === 429 || error.status >= 500;
	return isUnreachableRead(error);
}

export function transientReadRetryDelay(attempt: number) {
	return Math.min(500 * 2 ** attempt, 2000);
}
