/**
 * Visitors where GDPR, UK GDPR or the Swiss FADP apply get the stricter
 * defaults: no session replay, nothing kept in the browser for analytics, and
 * "Help improve ytimesy" starts off. The country comes from Cloudflare
 * (CF-IPCountry / request.cf.country).
 */
export const STRICT_PRIVACY_COUNTRIES: ReadonlySet<string> = new Set([
	// EU 27
	"AT",
	"BE",
	"BG",
	"HR",
	"CY",
	"CZ",
	"DK",
	"EE",
	"FI",
	"FR",
	"DE",
	"GR",
	"HU",
	"IE",
	"IT",
	"LV",
	"LT",
	"LU",
	"MT",
	"NL",
	"PL",
	"PT",
	"RO",
	"SK",
	"SI",
	"ES",
	"SE",
	// EEA
	"IS",
	"LI",
	"NO",
	// UK and Switzerland
	"GB",
	"CH",
]);

/**
 * Where analytics waits for consent (no session replay, nothing kept in the
 * browser): the countries above, plus Turkey (KVKK), South Korea (PIPA) and
 * Quebec (Law 25, analyticsOptInRequest). Training's default follows only
 * the list above, as the Terms and the training policy say.
 */
export const ANALYTICS_OPT_IN_COUNTRIES: ReadonlySet<string> = new Set([
	...STRICT_PRIVACY_COUNTRIES,
	"TR",
	"KR",
]);

/** Whether the stricter defaults apply; unknown or missing country: no. */
export function strictPrivacyCountry(country: string | null | undefined) {
	if (!country) return false;
	return STRICT_PRIVACY_COUNTRIES.has(country.trim().toUpperCase());
}

/** The visitor's country from a Workers request: the header, then request.cf. */
export function requestCountry(request: {
	readonly headers: Headers;
	readonly cf?: unknown;
}): string | null {
	const header = request.headers.get("cf-ipcountry");
	if (header) return header;
	const cf = request.cf as { country?: unknown } | undefined;
	return typeof cf?.country === "string" ? cf.country : null;
}

/** Quebec (Law 25): a Canadian connection Cloudflare places in region QC. */
function quebecRequest(request: { readonly cf?: unknown }, country: string) {
	if (country.trim().toUpperCase() !== "CA") return false;
	const cf = request.cf as { regionCode?: unknown } | undefined;
	return (
		typeof cf?.regionCode === "string" && cf.regionCode.toUpperCase() === "QC"
	);
}

/** Whether a Workers request gets the stricter defaults (training starts off). */
export function strictPrivacyRequest(request: {
	readonly headers: Headers;
	readonly cf?: unknown;
}) {
	return strictPrivacyCountry(requestCountry(request));
}

/** Whether analytics waits for consent for this request (ANALYTICS_OPT_IN_COUNTRIES). */
export function analyticsOptInRequest(request: {
	readonly headers: Headers;
	readonly cf?: unknown;
}) {
	const country = requestCountry(request);
	if (!country) return false;
	return (
		ANALYTICS_OPT_IN_COUNTRIES.has(country.trim().toUpperCase()) ||
		quebecRequest(request, country)
	);
}

/** US states where session replay waits for an Accept (wiretap-law suits over replay scripts). */
export const REPLAY_CONSENT_US_STATES: ReadonlySet<string> = new Set([
	"CA",
	"FL",
	"IL",
]);

/**
 * California, Florida or Illinois (Cloudflare's country and region code for
 * the connection): analytics stays on, session replay waits for an Accept.
 */
export function replayConsentRequest(request: {
	readonly headers: Headers;
	readonly cf?: unknown;
}) {
	const country = requestCountry(request);
	if (country?.trim().toUpperCase() !== "US") return false;
	const cf = request.cf as { regionCode?: unknown } | undefined;
	return (
		typeof cf?.regionCode === "string" &&
		REPLAY_CONSENT_US_STATES.has(cf.regionCode.toUpperCase())
	);
}
