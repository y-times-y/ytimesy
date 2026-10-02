import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MatrixDotLoader } from "./matrix-dot-loader";
import { Spinner } from "./spinner";

describe("matrix dot loader", () => {
	it("renders nine fixed cells with clockwise perimeter phases and a static center", () => {
		const html = renderToStaticMarkup(createElement(MatrixDotLoader));
		const cells = html.match(/<i\b[^>]*>/g) ?? [];
		expect(cells).toHaveLength(9);
		expect(
			cells.map((cell) => cell.match(/--t-matrix-step:(\d)/)?.[1] ?? ""),
		).toEqual(["0", "1", "2", "7", "", "3", "6", "5", "4"]);
		expect(cells[4]).toContain('class="t-matrix-center"');
		expect(html).toContain('aria-hidden="true"');
	});
	it("keeps the shared loading status accessible without a rotating SVG", () => {
		const html = renderToStaticMarkup(
			createElement(Spinner, { className: "size-5" }),
		);
		expect(html).toContain('role="status"');
		expect(html).toContain('aria-label="Loading"');
		expect(html).toContain('class="t-matrix size-5"');
		expect(html.match(/<i\b/g)).toHaveLength(9);
		expect(html).not.toContain("<svg");
		expect(html).not.toContain("aria-hidden");
	});
});
