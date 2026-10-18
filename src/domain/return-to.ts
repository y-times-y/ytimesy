/**
 * Where sign-in returns to: a same-origin relative path only, so a crafted
 * link can never send someone to another site after signing in (no open
 * redirect). Anything else falls back to the workspace home.
 *
 * The query parameter is `redirectTo`, the name the auth UI library already
 * reads and forwards (two-factor step, email links, OAuth callbacks).
 */
export const RETURN_TO_PARAM = "redirectTo";
export const DEFAULT_RETURN_TO = "/";

const PROBE_ORIGIN = "https://return-to.invalid";

function hasControlOrBackslash(value: string) {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (character === "\\" || code <= 0x1f || (code >= 0x7f && code <= 0x9f))
			return true;
	}
	return false;
}

/** The path to return to after sign-in, or "/" when the value is not a safe local path. */
export function safeReturnTo(value: unknown): string {
	if (typeof value !== "string" || value.length > 2048)
		return DEFAULT_RETURN_TO;
	if (hasControlOrBackslash(value)) return DEFAULT_RETURN_TO;
	// A relative path only: not absolute (https:, javascript:), not //host.
	if (!value.startsWith("/") || value.startsWith("//"))
		return DEFAULT_RETURN_TO;
	let url: URL;
	try {
		url = new URL(value, PROBE_ORIGIN);
	} catch {
		return DEFAULT_RETURN_TO;
	}
	if (url.origin !== PROBE_ORIGIN) return DEFAULT_RETURN_TO;
	// Encoded tricks that decode to another host or back into sign-in.
	let decoded: string;
	try {
		decoded = decodeURIComponent(url.pathname);
	} catch {
		return DEFAULT_RETURN_TO;
	}
	if (decoded.startsWith("//") || hasControlOrBackslash(decoded))
		return DEFAULT_RETURN_TO;
	if (url.pathname === "/auth" || url.pathname.startsWith("/auth/"))
		return DEFAULT_RETURN_TO;
	if (url.pathname.startsWith("/api/")) return DEFAULT_RETURN_TO;
	// The parameter itself is dropped so return paths never nest.
	url.searchParams.delete(RETURN_TO_PARAM);
	return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * The return path for the page being viewed: on a sign-in page, its
 * (validated) parameter; anywhere else, the page itself, since a signed-out
 * visitor to a deep link is shown sign-in in place.
 */
export function returnToForLocation(pathname: string, search: string) {
	if (pathname === "/auth" || pathname.startsWith("/auth/"))
		return safeReturnTo(new URLSearchParams(search).get(RETURN_TO_PARAM));
	return safeReturnTo(`${pathname}${search}`);
}

/** Carries the return path on links between sign-in views; other links are unchanged. */
export function withReturnTo(href: string, returnTo: string) {
	if (!href.startsWith("/auth/")) return href;
	const url = new URL(href, PROBE_ORIGIN);
	const safe = safeReturnTo(returnTo);
	if (safe === DEFAULT_RETURN_TO) url.searchParams.delete(RETURN_TO_PARAM);
	else url.searchParams.set(RETURN_TO_PARAM, safe);
	return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * The current URL with an unsafe return parameter replaced by its safe value
 * (or removed), or null when it is already safe. The auth UI reads the raw
 * parameter from the address bar, so it must never hold an unsafe value.
 */
export function sanitizedReturnToUrl(
	pathname: string,
	search: string,
	hash: string,
) {
	const params = new URLSearchParams(search);
	const raw = params.get(RETURN_TO_PARAM);
	if (raw === null) return null;
	const safe = safeReturnTo(raw);
	if (safe === raw && safe !== DEFAULT_RETURN_TO) return null;
	if (safe === DEFAULT_RETURN_TO) params.delete(RETURN_TO_PARAM);
	else params.set(RETURN_TO_PARAM, safe);
	const query = params.toString();
	return `${pathname}${query ? `?${query}` : ""}${hash}`;
}
