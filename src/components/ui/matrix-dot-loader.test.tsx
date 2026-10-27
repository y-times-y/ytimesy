import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MatrixDotLoader } from "./matrix-dot-loader";
import { Spinner } from "./spinner";

describe("matrix dot loader", () => {
	it("renders nine pixels phased as a diagonal wave from the top-left", () => {
		const html = renderToStaticMarkup(createElement(MatrixDotLoader));
		const cells = html.match(/<i\b[^>]*>/g) ?? [];
		expect(cells).toHaveLength(9);
		expect(
			cells.map((cell) => cell.match(/--t-matrix-diag:(\d)/)?.[1] ?? ""),
		).toEqual(["0", "1", "2", "1", "2", "3", "2", "3", "4"]);
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
