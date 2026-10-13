/**
 * Cloudflare Workers throw on the "error" redirect mode. Libraries that default to it
 * (the MCP HTTP transport) get "manual" instead: a 3xx then arrives as a non-ok
 * response that they reject, so redirects are still never followed.
 */
export function redirectRefusingFetch(
	base: typeof fetch = fetch,
): typeof fetch {
	return (input, init) =>
		base(
			input,
			init?.redirect === "error" ? { ...init, redirect: "manual" } : init,
		);
}
