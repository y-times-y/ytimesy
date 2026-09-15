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
		throw new Error(message || "Request failed.");
	}
	return response.json();
}
