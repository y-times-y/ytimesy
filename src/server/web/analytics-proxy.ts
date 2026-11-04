import { ANALYTICS_PROXY_PATH } from "#/domain/analytics";

/**
 * First-party path for browser analytics: /r/* on our own origin is forwarded
 * to PostHog (US). Blockers list PostHog's hosts and its managed proxy's
 * CNAME target (proxyhog.com), so a same-origin path is the one they can't
 * tell apart from the app. The path stays neutral on purpose: no "posthog",
 * "analytics" or "tracking" in it.
 */

const INGEST_HOST = "us.i.posthog.com";
const ASSETS_HOST = "us-assets.i.posthog.com";

/** Request headers PostHog needs; cookies and auth never leave our origin. */
const FORWARDED_HEADERS = [
	"accept",
	"content-encoding",
	"content-type",
	"user-agent",
];

/** PostHog's URL for a /r/* request, or null when the path isn't ours. */
export function analyticsProxyTarget(url: URL): URL | null {
	const prefix = `${ANALYTICS_PROXY_PATH}/`;
	if (!url.pathname.startsWith(prefix)) return null;
	const path = url.pathname.slice(ANALYTICS_PROXY_PATH.length);
	const host =
		path.startsWith("/static/") || path.startsWith("/array/")
			? ASSETS_HOST
			: INGEST_HOST;
	return new URL(`https://${host}${path}${url.search}`);
}

/** Forwards a /r/* request to PostHog; null for every other request. */
export async function proxyAnalytics(
	request: Request,
	send: typeof fetch = fetch,
): Promise<Response | null> {
	const target = analyticsProxyTarget(new URL(request.url));
	if (!target) return null;
	if (!["GET", "HEAD", "POST"].includes(request.method))
		return new Response(null, { status: 405 });
	const headers = new Headers();
	for (const name of FORWARDED_HEADERS) {
		const value = request.headers.get(name);
		if (value !== null) headers.set(name, value);
	}
	const upstream = await send(target, {
		method: request.method,
		headers,
		...(request.method === "POST"
			? { body: request.body, duplex: "half" as const }
			: {}),
		redirect: "manual",
	});
	const response = new Response(upstream.body, upstream);
	response.headers.delete("set-cookie");
	// fetch already decompressed the body; passing these on makes the
	// browser decode it again (ERR_CONTENT_DECODING_FAILED).
	response.headers.delete("content-encoding");
	response.headers.delete("content-length");
	return response;
}
