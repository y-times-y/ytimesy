const loopbackAliases: Record<string, string> = {
	localhost: "127.0.0.1",
	"127.0.0.1": "localhost",
};

/**
 * Local development serves the same app as both `localhost` and `127.0.0.1`.
 * Cookies are per host, so a sign-in started on the alias sets its OAuth state
 * cookie where the provider callback (always APP_URL) cannot see it. Send the
 * alias to the APP_URL host before any cookie is set. Only loopback aliases on
 * the APP_URL port are redirected; every other host is left alone.
 */
export function canonicalOriginRedirect(
	request: Request,
	appUrl: string | undefined,
): Response | null {
	if (!appUrl) return null;
	let canonical: URL;
	try {
		canonical = new URL(appUrl);
	} catch {
		return null;
	}
	const url = new URL(request.url);
	if (url.hostname === canonical.hostname) return null;
	if (loopbackAliases[canonical.hostname] !== url.hostname) return null;
	if (url.port !== canonical.port || url.protocol !== canonical.protocol)
		return null;
	if (request.method !== "GET" && request.method !== "HEAD") return null;
	url.hostname = canonical.hostname;
	return new Response(null, {
		status: 307,
		headers: { location: url.toString() },
	});
}
