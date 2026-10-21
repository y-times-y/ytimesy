import { describe, expect, it } from "vitest";
import { rfbRequiresPassword } from "../scripts/vnc-rfb-probe";

describe("rfbRequiresPassword", () => {
	it("accepts VNC auth alone", () => {
		expect(rfbRequiresPassword("types=2 server=RFB 003.008")).toBe(true);
	});
	it("accepts VeNCrypt or TLS", () => {
		expect(rfbRequiresPassword("types=19")).toBe(true);
		expect(rfbRequiresPassword("types=18")).toBe(true);
	});
	it("refuses when None is offered, even beside a password", () => {
		expect(rfbRequiresPassword("types=1")).toBe(false);
		expect(rfbRequiresPassword("types=1,2")).toBe(false);
	});
	it("refuses errors and empty answers", () => {
		expect(
			rfbRequiresPassword("error:ConnectionError:closed banner=b'RFB 003.008'"),
		).toBe(false);
		expect(rfbRequiresPassword("")).toBe(false);
	});
});
