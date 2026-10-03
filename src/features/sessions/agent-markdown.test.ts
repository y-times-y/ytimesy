import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentMarkdown } from "./agent-markdown";

const render = (text: string, streaming = false) =>
	renderToStaticMarkup(
		createElement(AgentMarkdown, { text, streaming, onOpenFile: () => {} }),
	);

describe("assistant Markdown", () => {
	it("renders headings, emphasis, quotes and external links", () => {
		const html = render(
			"## Heading\n\n*italic* and ~~removed~~\n\n> Quote\n\n[Docs](https://example.com/docs)",
		);
		for (const tag of ["h2", "em", "del", "blockquote"])
			expect(html).toContain(`<${tag}`);
		expect(html).toContain('href="https://example.com/docs"');
		expect(html).toContain('rel="noopener noreferrer"');
	});
	it("preserves list starts, nesting, tables and checkboxes", () => {
		const html = render(
			"3. Three\n   - Nested\n4. Four\n\n- [x] Done\n\n| A | B |\n| --- | --- |\n| one | two |",
		);
		expect(html).toContain('start="3"');
		expect(html).toContain("<ul");
		expect(html).toContain("<table");
		expect(html).toContain('type="checkbox"');
		expect(html).toContain("checked");
	});
	it("keeps inline file mentions and file links connected to the IDE", () => {
		const html = render("Read `src/main.ts` or [source](src/main.ts).");
		expect(html.match(/title="Open src\/main.ts"/g), html).toHaveLength(2);
		expect(html).toContain("source");
	});
	it("retains package filenames in completed and streaming responses", () => {
		for (const streaming of [false, true]) {
			const html = render(
				"I already read `package.json`; its test command is `pnpm test` (`vitest run`).",
				streaming,
			);
			expect(html).toContain('title="Open package.json"');
			expect(html).toContain('class="session-file-name">package.json</span>');
			expect(html.replace(/<[^>]+>/g, "")).toContain("pnpm test");
		}
	});
	it("formats incomplete code fences while streaming without creating file buttons inside code", () => {
		const html = render("```ts\nconst path = 'src/main.ts';", true);
		expect(html).toContain("<pre");
		expect(html).toContain("<code");
		expect(html).not.toContain("session-file-open");
	});
	it("does not execute raw HTML or unsafe URLs or load remote images", () => {
		const html = render(
			"[bad](javascript:alert%281%29)\n\n<script>alert(1)</script>\n\n![Preview](https://example.com/tracker.png)",
		);
		expect(html).not.toContain("javascript:");
		expect(html).not.toContain("<script");
		expect(html).not.toContain("<img");
		expect(html).toContain('href="https://example.com/tracker.png"');
	});
});
