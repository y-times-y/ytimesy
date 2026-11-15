import { describe, expect, it } from "vitest";
import {
	ANALYTICS_OPT_IN_COUNTRIES,
	analyticsOptInRequest,
	requestCountry,
	STRICT_PRIVACY_COUNTRIES,
	strictPrivacyCountry,
	strictPrivacyRequest,
} from "./privacy-region";

describe("privacy region", () => {
	it("covers the EU 27, the EEA, the UK and Switzerland", () => {
		expect(STRICT_PRIVACY_COUNTRIES.size).toBe(27 + 3 + 2);
		for (const country of ["DE", "FR", "IE", "NO", "IS", "LI", "GB", "CH"])
			expect(strictPrivacyCountry(country)).toBe(true);
		// Training's default does not change in the analytics-only regions.
		for (const country of ["TR", "KR"])
			expect(strictPrivacyCountry(country)).toBe(false);
	});

	it("waits for analytics consent there and in Turkey and South Korea", () => {
		expect(ANALYTICS_OPT_IN_COUNTRIES.size).toBe(27 + 3 + 2 + 2);
		for (const country of ["DE", "GB", "CH", "TR", "KR"])
			expect(
				analyticsOptInRequest({
					headers: new Headers({ "CF-IPCountry": country }),
				}),
			).toBe(true);
	});

	it("is off elsewhere, and when the country is unknown", () => {
		for (const country of ["US", "CA", "IN", "JP", "XX", "T1", "", null])
			expect(strictPrivacyCountry(country)).toBe(false);
		expect(strictPrivacyCountry(undefined)).toBe(false);
	});

	it("ignores case and spaces", () => {
		expect(strictPrivacyCountry(" de ")).toBe(true);
	});

	it("reads CF-IPCountry, then request.cf.country", () => {
		expect(
			requestCountry({ headers: new Headers({ "CF-IPCountry": "GB" }) }),
		).toBe("GB");
		expect(
			requestCountry({ headers: new Headers(), cf: { country: "FR" } }),
		).toBe("FR");
		expect(requestCountry({ headers: new Headers() })).toBeNull();
	});

	it("waits for analytics consent in Quebec, not the rest of Canada", () => {
		const canada = (regionCode?: string) => ({
			headers: new Headers({ "CF-IPCountry": "CA" }),
			cf: { country: "CA", regionCode },
		});
		expect(analyticsOptInRequest(canada("QC"))).toBe(true);
		expect(analyticsOptInRequest(canada("qc"))).toBe(true);
		expect(analyticsOptInRequest(canada("ON"))).toBe(false);
		expect(analyticsOptInRequest(canada())).toBe(false);
		// A QC region code outside Canada is not Quebec.
		expect(
			analyticsOptInRequest({
				headers: new Headers({ "CF-IPCountry": "US" }),
				cf: { regionCode: "QC" },
			}),
		).toBe(false);
		expect(analyticsOptInRequest({ headers: new Headers() })).toBe(false);
		// Quebec keeps training's ordinary default.
		expect(strictPrivacyRequest(canada("QC"))).toBe(false);
	});
});
