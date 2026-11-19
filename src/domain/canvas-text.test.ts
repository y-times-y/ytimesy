import { describe, expect, it } from "vitest";
import {
	CANVAS_READ_PAGE,
	canvasDescription,
	canvasHasImages,
	canvasOutline,
	canvasOutlinePage,
	canvasSizeKb,
} from "./canvas-text";

const BASE64 = "A".repeat(5_000);
const DOC = `<!doctype html><html><head><title>Thread art</title>
<meta charset="utf-8"><style>body{background:url(data:image/png;base64,${BASE64})}.x{color:red}</style>
<script>var secret = "SCRIPT_TEXT"; </script></head>
<body><!-- a comment -->
<h1>Pricing &amp; plans</h1>
<p>Three options, <b>side</b> by side.</p>
<img src="data:image/png;base64,${BASE64}" alt="Logo wall">
<img src="https://cdn.example.com/img/hero-shot.png?x=1">
<h2>Option A</h2>
<ul><li>Cheap</li><li>Fast</li></ul>
<table><tr><th>Plan</th><th>Price</th></tr><tr><td>Pro</td><td>$20</td></tr></table>
<svg width="10" height="10"><title>Growth chart</title><path d="M0 0L10 10"/></svg>
<svg viewBox="0 0 1 1"><circle r="1"/></svg>
<button data-ytimesy-prompt="Go with option A">Pick A</button>
<script>alert("MORE_SCRIPT")</script>
</body></html>`;

describe("canvasOutline", () => {
	const outline = canvasOutline(DOC);

	it("keeps headings, paragraphs, lists and flattens tables", () => {
		expect(outline).toContain("# Pricing & plans");
		expect(outline).toContain("Three options, side by side.");
		expect(outline).toContain("## Option A");
		expect(outline).toContain("- Cheap");
		expect(outline).toContain("- Fast");
		expect(outline).toContain("Plan | Price");
		expect(outline).toContain("Pro | $20");
		expect(outline).toContain("Pick A");
	});

	it("drops scripts, styles, comments, head and every data: URI", () => {
		for (const gone of [
			"SCRIPT_TEXT",
			"MORE_SCRIPT",
			"background",
			"a comment",
			"base64",
			BASE64.slice(0, 40),
			"<",
		])
			expect(outline).not.toContain(gone);
		expect(outline.length).toBeLessThan(500);
	});

	it("shows images by alt or file name, and svg by its title", () => {
		expect(outline).toContain("[image: Logo wall]");
		expect(outline).toContain("[image: hero-shot.png]");
		expect(outline).toContain("[svg: Growth chart]");
		expect(outline).toContain("[svg]");
	});

	it("survives a document cut off inside a script or tag", () => {
		expect(canvasOutline("<h1>Hi</h1><script>var a = 1;")).toBe("# Hi");
		expect(canvasOutline("<p>one</p><div class=")).toContain("one");
	});

	it("never lets a long data: URI in text through", () => {
		expect(canvasOutline(`<p>x data:image/png;base64,${BASE64}</p>`)).toBe(
			"x [data]",
		);
	});
});

describe("canvasDescription", () => {
	it("starts with the title and headings, counts alt text, stays under the limit", () => {
		const text = canvasDescription(DOC);
		expect(text.startsWith("Thread art · Pricing & plans · Option A")).toBe(
			true,
		);
		expect(text).toContain("[image: Logo wall]");
		expect(text.length).toBeLessThanOrEqual(300);
		expect(text).not.toContain("SCRIPT_TEXT");
	});

	it("cuts long text with an ellipsis", () => {
		const text = canvasDescription(`<p>${"word ".repeat(200)}</p>`);
		expect(text.length).toBeLessThanOrEqual(300);
		expect(text.endsWith("…")).toBe(true);
	});

	it("is empty for a document with no visible text", () => {
		expect(canvasDescription("<script>1</script><style>a{}</style>")).toBe("");
	});
});

describe("canvasHasImages and size", () => {
	it("sees img, picture and image data: URIs", () => {
		expect(canvasHasImages('<img src="a.png">')).toBe(true);
		expect(canvasHasImages("<picture></picture>")).toBe(true);
		expect(canvasHasImages("a{background:url(data:image/png;base64,AA)}")).toBe(
			true,
		);
		expect(canvasHasImages("<p>none</p><svg></svg>")).toBe(false);
	});

	it("rounds the size to a tenth of a KB", () => {
		expect(canvasSizeKb(1536)).toBe(1.5);
		expect(canvasSizeKb(0)).toBe(0);
		expect(canvasSizeKb(14_540)).toBe(14.2);
	});
});

describe("canvasOutlinePage", () => {
	const lines = Array.from(
		{ length: 1_500 },
		(_, i) => `line ${i} ${"y".repeat(20)}`,
	);
	const outline = lines.join("\n");

	it("caps a page and pages the rest at line ends", () => {
		const first = canvasOutlinePage(outline, 1);
		expect(first.text.length).toBeLessThanOrEqual(CANVAS_READ_PAGE);
		expect(first.parts).toBeGreaterThan(2);
		const all = Array.from(
			{ length: first.parts },
			(_, i) => canvasOutlinePage(outline, i + 1).text,
		).join("\n");
		expect(all).toBe(outline);
		expect(first.text.endsWith("y".repeat(20))).toBe(true);
	});

	it("clamps parts out of range and handles short or unbroken text", () => {
		expect(canvasOutlinePage("short", 9)).toMatchObject({
			text: "short",
			part: 1,
			parts: 1,
		});
		const unbroken = canvasOutlinePage("z".repeat(30_000), 3);
		expect(unbroken.parts).toBe(3);
		expect(unbroken.text.length).toBe(6_000);
		expect(canvasOutlinePage(outline, 0).part).toBe(1);
	});
});
