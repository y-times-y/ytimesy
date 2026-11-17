import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { BRAND_MARK_SILHOUETTE, YSquaredMark } from "./y-squared-mark";

it("draws the brand mark's own border, hollow", () => {
	const svg = readFileSync(
		new URL("../../../public/brand/mark.svg", import.meta.url),
		"utf8",
	);
	expect(svg).toContain(`d="${BRAND_MARK_SILHOUETTE}"`);
	const html = renderToStaticMarkup(<YSquaredMark size={28} />);
	expect(html).toContain('class="y2-mark-border"');
	expect(html).toContain('fill="none"');
});

it("reads as Y² at its size and stays out of the accessibility tree", () => {
	const html = renderToStaticMarkup(<YSquaredMark size={28} />);
	expect(html).toContain("--y2m:28px");
	expect(html).toContain('aria-hidden="true"');
	expect(html).toContain('class="y2-mark-exponent"');
	expect(html).not.toContain("y2-mark-light");
});

it("runs a light around the outline only while live", () => {
	const html = renderToStaticMarkup(<YSquaredMark size={16} live />);
	expect(html).toContain('data-live="true"');
	expect(html).toContain('class="y2-mark-light"');
});
