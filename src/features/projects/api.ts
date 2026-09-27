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

export function retryTransientRead(failureCount: number, error: Error) {
	if (failureCount >= 2) return false;
	if (error instanceof HttpRequestError)
		return error.status === 408 || error.status === 429 || error.status >= 500;
	return error instanceof TypeError;
}
