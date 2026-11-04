import { BUILD_ID, BUILD_ID_HEADER } from "../../lib/build-id";

/**
 * Baseline browser protections for every web response. No script CSP yet:
 * TanStack Start hydrates with inline scripts, so a nonce-based policy needs
 * its own reviewed rollout. Framing stays same-origin for the Desktop viewer.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
	"Strict-Transport-Security": "max-age=31536000; includeSubDomains",
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "SAMEORIGIN",
	"Content-Security-Policy": "frame-ancestors 'self'",
	"Referrer-Policy": "strict-origin-when-cross-origin",
	"Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

/**
 * Adds missing baseline headers; a route's own value wins. Upgrades pass
 * through. Every response also names the build that answered it
 * (BUILD_ID_HEADER), which the production deploy's smoke check reads.
 */
export function withSecurityHeaders(response: Response): Response {
	if (response.status === 101 || response.webSocket) return response;
	const secured = new Response(response.body, response);
	for (const [name, value] of Object.entries(SECURITY_HEADERS))
		if (!secured.headers.has(name)) secured.headers.set(name, value);
	secured.headers.set(BUILD_ID_HEADER, BUILD_ID);
	return secured;
}
