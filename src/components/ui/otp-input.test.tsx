import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OtpInput } from "./otp-input";

const render = (props: Partial<Parameters<typeof OtpInput>[0]> = {}) =>
	renderToStaticMarkup(
		<OtpInput value="" onChange={() => undefined} {...props} />,
	);

describe("OtpInput", () => {
	it("draws one box per digit, each with its own label", () => {
		const html = render({ label: "6-digit code" });
		expect(html.match(/<input /g)).toHaveLength(6);
		expect(html).toContain("<legend");
		expect(html).toContain("6-digit code");
		for (let digit = 1; digit <= 6; digit++)
			expect(html).toContain(`aria-label="Digit ${digit} of 6"`);
	});

	it("asks phones for the numeric keyboard and the emailed code", () => {
		const html = render();
		expect(html.match(/inputMode="numeric"/g)).toHaveLength(6);
		expect(html.match(/pattern="\[0-9\]\*"/g)).toHaveLength(6);
		// One box carries the one-time-code hint, so a phone offers the code once.
		expect(html.match(/autoComplete="one-time-code"/g)).toHaveLength(1);
		expect(html.indexOf("one-time-code")).toBeLessThan(
			html.indexOf('aria-label="Digit 2 of 6"'),
		);
	});

	it("shows the digits typed so far, one in each box", () => {
		const html = render({ value: "482" });
		expect(html.match(/value="4"/g)).toHaveLength(1);
		expect(html).toContain('value="8"');
		expect(html).toContain('value="2"');
		expect(html.match(/value=""/g)).toHaveLength(3);
	});

	it("marks every box invalid, or disabled, when the page says so", () => {
		expect(
			render({ invalid: true }).match(/aria-invalid="true"/g),
		).toHaveLength(6);
		expect(render().match(/aria-invalid="/g)).toBeNull();
		expect(render({ disabled: true }).match(/disabled=""/g)).toHaveLength(6);
	});

	it("takes a different length", () => {
		expect(render({ length: 4 }).match(/<input /g)).toHaveLength(4);
	});
});
