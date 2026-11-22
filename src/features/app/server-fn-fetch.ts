import { HttpRequestError } from "../projects/api";

/**
 * The fetch every server function call in the browser uses (src/start.ts).
 *
 * A server function that throws a Response (requireUser's 401 "Sign in
 * required", a 429 rate limit) answers it raw (`x-tss-raw: true`), and
 * TanStack Start's client then hands that Response back as the call's
 * *result* without looking at its status. So a signed-out tab "succeeded"
 * with a Response object, and the first code that read a field of it
 * crashed (the usage banner's `windows.filter`, after a session ended).
 * A raw answer that is not ok becomes a thrown error here instead, with the
 * server's text and status, as `requestJson` does for the plain API routes.
 */
export async function serverFnFetch(
	input: RequestInfo | URL,
	init?: RequestInit,
	fetchImpl: typeof fetch = fetch,
): Promise<Response> {
	const response = await fetchImpl(input, init);
	if (response.ok || response.headers.get("x-tss-raw") !== "true")
		return response;
	const text = (await response.text().catch(() => "")).trim();
	throw new HttpRequestError(
		text && text.length <= 200 ? text : "Request failed.",
		response.status,
	);
}
