/**
 * Referral attribution: where a visitor first came from (first touch wins).
 *
 * The browser records the first touch once, after the page has painted
 * (src/features/analytics/first-touch.ts), in a first-party cookie; sign-up
 * copies it onto the new account (user_attribution) and into PostHog as
 * `initial_*` person properties. The server never trusts the cookie: every
 * value is parsed again with the same bounds before it is stored.
 */

export const FIRST_TOUCH_COOKIE = "yt_first_touch";
/** About 90 days. */
export const FIRST_TOUCH_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

export const ATTRIBUTION_PARAMS = [
	"ref",
	"utm_source",
	"utm_medium",
	"utm_campaign",
	"utm_content",
	"utm_term",
] as const;
type AttributionParam = (typeof ATTRIBUTION_PARAMS)[number];

export type FirstTouch = {
	readonly [K in AttributionParam]?: string;
} & {
	/** Host of the page that linked here, without "www."; never our own host. */
	readonly referrer_host?: string;
	/** Path the visitor landed on, without query or hash. */
	readonly landing_path?: string;
	/** When the first touch happened (ISO 8601). */
	readonly at: string;
};

const REF_PATTERN = /^[a-z0-9_-]{1,32}$/;
const HOST_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const UTM_MAX = 64;
const PATH_MAX = 120;

/** `ref`: lower case, `[a-z0-9_-]`, at most 32 characters; anything else is dropped. */
export function sanitizeRef(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const ref = value.trim().toLowerCase();
	return REF_PATTERN.test(ref) ? ref : undefined;
}

/** UTM values: lower case, runs of other characters become "_", at most 64. */
export function sanitizeUtm(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const utm = value
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, UTM_MAX);
	return utm || undefined;
}

/** A bare host name from a referrer URL or host; undefined for our own host. */
export function sanitizeReferrerHost(
	value: unknown,
	ownHost?: string,
): string | undefined {
	if (typeof value !== "string" || !value) return undefined;
	let host: string;
	try {
		host = value.includes("://") ? new URL(value).hostname : value;
	} catch {
		return undefined;
	}
	host = host.toLowerCase().replace(/^www\./, "");
	if (host.length > 100 || !HOST_PATTERN.test(host)) return undefined;
	const own = ownHost?.toLowerCase().replace(/^www\./, "");
	if (own && (host === own || host.endsWith(`.${own}`))) return undefined;
	return host;
}

/** The path alone, bounded; ids deep in a path are cut by the length bound. */
export function sanitizeLandingPath(value: unknown): string | undefined {
	if (typeof value !== "string" || !value.startsWith("/")) return undefined;
	const path = value
		.split(/[?#]/, 1)[0]
		.replace(/[^A-Za-z0-9/._~-]/g, "")
		.slice(0, PATH_MAX);
	return path || undefined;
}

function sanitizeAt(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const time = Date.parse(value);
	return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function compact(touch: Record<string, string | undefined>): FirstTouch | null {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(touch))
		if (value !== undefined) result[key] = value;
	return result.at ? (result as unknown as FirstTouch) : null;
}

/** Applies every bound to an untrusted object (a cookie, a request). */
export function sanitizeFirstTouch(
	value: unknown,
	ownHost?: string,
): FirstTouch | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	return compact({
		ref: sanitizeRef(raw.ref),
		utm_source: sanitizeUtm(raw.utm_source),
		utm_medium: sanitizeUtm(raw.utm_medium),
		utm_campaign: sanitizeUtm(raw.utm_campaign),
		utm_content: sanitizeUtm(raw.utm_content),
		utm_term: sanitizeUtm(raw.utm_term),
		referrer_host: sanitizeReferrerHost(raw.referrer_host, ownHost),
		landing_path: sanitizeLandingPath(raw.landing_path),
		at: sanitizeAt(raw.at),
	});
}

/** The first touch a page load represents: its URL, referrer and time. */
export function firstTouchFromPage(page: {
	readonly url: URL;
	readonly referrer: string;
	readonly now: Date;
}): FirstTouch {
	const search = page.url.searchParams;
	const at = page.now.toISOString();
	return (
		sanitizeFirstTouch(
			{
				ref: search.get("ref"),
				utm_source: search.get("utm_source"),
				utm_medium: search.get("utm_medium"),
				utm_campaign: search.get("utm_campaign"),
				utm_content: search.get("utm_content"),
				utm_term: search.get("utm_term"),
				referrer_host: page.referrer,
				landing_path: page.url.pathname,
				at,
			},
			page.url.hostname,
		) ?? { at }
	);
}

export function serializeFirstTouch(touch: FirstTouch): string {
	return encodeURIComponent(JSON.stringify(touch));
}

/** The first touch in a Cookie header (or document.cookie), sanitized again. */
export function readFirstTouchCookie(
	cookieHeader: string | null | undefined,
	ownHost?: string,
): FirstTouch | null {
	if (!cookieHeader) return null;
	for (const part of cookieHeader.split(";")) {
		const index = part.indexOf("=");
		if (index < 0 || part.slice(0, index).trim() !== FIRST_TOUCH_COOKIE)
			continue;
		const value = part.slice(index + 1).trim();
		if (value.length > 2_000) return null;
		try {
			return sanitizeFirstTouch(JSON.parse(decodeURIComponent(value)), ownHost);
		} catch {
			return null;
		}
	}
	return null;
}

/** A `Set-Cookie`/`document.cookie` string for the first touch. */
export function firstTouchCookieString(
	touch: FirstTouch,
	secure: boolean,
): string {
	return [
		`${FIRST_TOUCH_COOKIE}=${serializeFirstTouch(touch)}`,
		"Path=/",
		`Max-Age=${FIRST_TOUCH_MAX_AGE_SECONDS}`,
		"SameSite=Lax",
		...(secure ? ["Secure"] : []),
	].join("; ");
}

/**
 * The URL without `ref` and `utm_*` (path, remaining query and hash), or null
 * when it carries none, so nothing is rewritten.
 */
export function urlWithoutAttribution(url: URL): string | null {
	const search = new URLSearchParams(url.search);
	let changed = false;
	for (const key of [...search.keys()])
		if ((ATTRIBUTION_PARAMS as readonly string[]).includes(key)) {
			search.delete(key);
			changed = true;
		}
	if (!changed) return null;
	const query = search.toString();
	return `${url.pathname}${query ? `?${query}` : ""}${url.hash}`;
}

const BOT_USER_AGENT =
	/bot|crawl|spider|slurp|archiver|preview|fetch|headless|lighthouse|pagespeed|facebookexternalhit|embedly|quora link|whatsapp|vkshare|curl|wget|python-|go-http|node-fetch|axios|httpclient|phantom|puppeteer|playwright|selenium/i;

/** Crawlers, link unfurlers and automation: their visits are not attributed. */
export function isBotUserAgent(userAgent: string | null | undefined): boolean {
	return !userAgent || BOT_USER_AGENT.test(userAgent);
}

/** PostHog person properties, set once: `initial_ref`, `initial_utm_source`, ... */
export function initialAttributionProperties(
	touch: FirstTouch | null,
): Record<string, string> {
	if (!touch) return {};
	const properties: Record<string, string> = {};
	for (const key of [
		...ATTRIBUTION_PARAMS,
		"referrer_host",
		"landing_path",
	] as const) {
		const value = touch[key];
		if (value) properties[`initial_${key}`] = value;
	}
	return properties;
}
