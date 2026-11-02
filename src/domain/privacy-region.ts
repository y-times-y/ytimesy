/**
 * Visitors where GDPR, UK GDPR or the Swiss FADP apply get the stricter
 * defaults: no session replay, and "Help improve ytimesy" starts off.
 * The country comes from Cloudflare (CF-IPCountry / request.cf.country).
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
