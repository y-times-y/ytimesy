/**
 * Explicit CSRF guard for server functions, independent of TanStack Start's
 * built-in check: a state-changing /_serverFn request must come from this
 * app's own origin (Origin header, or Sec-Fetch-Site when Origin is absent).
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function serverFnOriginRejection(
	request: Request,
	appUrl: string | undefined,
): Response | null {
	const url = new URL(request.url);
	if (!url.pathname.startsWith("/_serverFn")) return null;
	if (SAFE_METHODS.has(request.method.toUpperCase())) return null;
	const allowed = new Set([url.origin]);
	if (appUrl) {
		try {
			allowed.add(new URL(appUrl).origin);
		} catch {}
	}
	const origin = request.headers.get("origin");
	if (
		origin
			? allowed.has(origin)
			: request.headers.get("sec-fetch-site") === "same-origin"
	)
		return null;
	return new Response("Cross-origin request blocked.", {
		status: 403,
		headers: { "content-type": "text/plain; charset=utf-8" },
	});
}
