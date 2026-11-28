import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FilePreview, PreviewModeSwitch } from "./file-preview";

// Markdown renders through the real renderer (the app loads it lazily).
vi.mock("../sessions/agent-markdown", async () => ({
	AgentMarkdown: (await import("../sessions/agent-markdown-renderer"))
		.AgentMarkdown,
}));

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
	it("draws README images like GitHub: centered blocks, sized and linked images", () => {
		const html = renderToStaticMarkup(
			createElement(FilePreview, {
				path: "README.md",
				content: {
					kind: "text",
					text: '<div align="center">\n  <img src="https://x.test/logo.png" width="120" alt="Logo">\n\n# Title\n</div>\n\n![alt](https://x.test/b.png)\n\n[![badge](https://x.test/c.svg)](https://x.test)\n',
				},
			}),
		);
		expect(html).toContain('<div align="center">');
		expect(html).toMatch(
			/<img[^>]*src="https:\/\/x\.test\/logo\.png"[^>]*width="120"/,
		);
		expect(html).toContain('src="https://x.test/b.png"');
		expect(html).toMatch(
			/<a [^>]*href="https:\/\/x\.test"[^>]*><img [^>]*c\.svg/,
		);
		expect(html).not.toContain("View image");
	});
	it("shows the alt text for a repo image it cannot load", () => {
		const html = renderToStaticMarkup(
			createElement(FilePreview, {
				path: "docs/README.md",
				content: { kind: "text", text: "![Diagram](img/a.png)" },
			}),
		);
		expect(html).toContain("<span>Diagram</span>");
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
