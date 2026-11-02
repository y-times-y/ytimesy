import { describe, expect, it } from "vitest";
import {
	requestCountry,
	STRICT_PRIVACY_COUNTRIES,
	strictPrivacyCountry,
} from "./privacy-region";

describe("privacy region", () => {
	it("covers the EU 27, the EEA, the UK and Switzerland", () => {
		expect(STRICT_PRIVACY_COUNTRIES.size).toBe(27 + 3 + 2);
		for (const country of ["DE", "FR", "IE", "NO", "IS", "LI", "GB", "CH"])
			expect(strictPrivacyCountry(country)).toBe(true);
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
});
