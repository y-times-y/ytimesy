import { describe, expect, it } from "vitest";
import { reservedBannerHeight } from "./consent-banner";

describe("space the cookie banner takes from the page", () => {
	it("is the banner's height plus its margin on a phone and a tablet, so it never covers the composer", () => {
		expect(reservedBannerHeight(390, 120)).toBe(136);
		expect(reservedBannerHeight(1023, 96)).toBe(112);
	});
	it("is nothing on a wide screen, where it floats in the corner", () => {
		expect(reservedBannerHeight(1024, 120)).toBe(0);
	});
});
