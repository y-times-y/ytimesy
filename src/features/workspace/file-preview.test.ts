import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FilePreview, PreviewModeSwitch } from "./file-preview";

describe("file previews", () => {
	it("renders Markdown with the existing renderer and no executable HTML", () => {
		const html = renderToStaticMarkup(
			createElement(FilePreview, {
				path: "README.md",
				content: {
					kind: "text",
					text: "# Heading\n\n1. First\n2. Second\n\n<script>window.bad=true</script>",
				},
			}),
		);
		expect(html).toContain("<h1");
		expect(html).toContain("<ol");
		expect(html).not.toContain("<script");
	});
	it("isolates SVG in an image instead of injecting it into the DOM", () => {
		const html = renderToStaticMarkup(
			createElement(FilePreview, {
				path: "image.svg",
				content: {
					kind: "text",
					text: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
				},
			}),
		);
		expect(html).toContain("<img");
		expect(html).toContain("data:image/svg+xml");
		expect(html).not.toContain("<svg");
		expect(html).not.toContain("<script");
	});
	it("offers accessible preview and source controls", () => {
		const html = renderToStaticMarkup(
			createElement(PreviewModeSwitch, {
				mode: "preview",
				onChange: () => undefined,
			}),
		);
		expect(html).toContain('aria-pressed="true">Preview');
		expect(html).toContain('aria-pressed="false">Code');
	});
});
