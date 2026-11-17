import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentMarkdown } from "./agent-markdown-renderer";
import { ReferenceContext } from "./agent-reference-chips";

const render = (text: string, streaming = false) =>
	renderToStaticMarkup(
		createElement(AgentMarkdown, { text, streaming, onOpenFile: () => {} }),
	);

const textOf = (html: string) => html.replace(/<[^>]+>/g, "");

describe("assistant Markdown", () => {
	it("replaces unresolved citations in prose without altering literal code", () => {
		for (const streaming of [false, true]) {
			const html = render(
				"Price citeturn1search0.\n\n`citeturn99search4`\n\n[Pricing](https://example.com/pricing)",
				streaming,
			);
			expect(html.replace(/<[^>]+>/g, "")).toContain(
				"Price (source unavailable).",
			);
			expect(html).not.toContain("turn1search0");
			expect(html).toContain("turn99search4");
			expect(html).toContain('href="https://example.com/pricing"');
		}
		expect(render("Text citeturn3", true)).not.toContain("turn3");
	});
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
	it("draws thread links as chips that open the thread, and bad ids as text", () => {
		const id = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
		const html = render(
			`[Fix sign-up form](thread:${id}) and [Gone](thread:nope) and \`[Code](thread:${id})\``,
		);
		expect(html).toContain(`href="/thread/${id}"`);
		expect(html).toContain('data-reference="thread"');
		expect(html).toContain(
			'<span class="reference-chip-label">Fix sign-up form</span>',
		);
		expect(html).toContain("<span>Gone</span>");
		expect(html).not.toContain("thread:nope");
		expect(html.match(/data-reference="thread"/g)).toHaveLength(1);
	});
	it("draws pull request URLs and pr: references as repo#number chips", () => {
		for (const streaming of [false, true]) {
			const html = render(
				"Merge https://github.com/acme/web/pull/8357, [the fix](pr:acme/api#12) and pr:acme/cli#3. `pr:acme/x#1`",
				streaming,
			);
			const chips = html.match(/data-reference="pull-request"/g);
			expect(chips, html).toHaveLength(3);
			const labels = [
				...html.matchAll(/class="reference-chip-label">(.*?)<\/span><\/a>/g),
			].map((match) => textOf(match[1] ?? ""));
			expect(labels).toEqual(["web#8357", "the fix", "cli#3"]);
			expect(html).toContain('href="https://github.com/acme/api/pull/12"');
			expect(html).toContain('title="acme/cli#3 · open pull request"');
			// The small secondary link opens GitHub.
			expect(html.match(/class="reference-chip-github"/g)).toHaveLength(3);
			expect(textOf(html)).toContain("pr:acme/x#1");
		}
	});
	it("draws event lines as quiet lines of their own", () => {
		for (const streaming of [false, true]) {
			const html = render(
				'Split it across three threads.\n::finished All 3 threads finished\n::event{kind="needs-you"} Merge pr:acme/web#8\n\n```\n::failed in code\n```',
				streaming,
			);
			const lines = [
				...html.matchAll(
					/<p class="session-event-line" data-event="([^"]+)"[^>]*>(.*?)<\/p>/g,
				),
			].map((match) => [match[1], textOf(match[2] ?? "")]);
			expect(lines).toEqual([
				["finished", "All 3 threads finished"],
				["needs-you", "Merge web#8"],
			]);
			// The event line is its own paragraph, not a soft break in the prose.
			expect(
				textOf(html.slice(0, html.indexOf('<p class="session-event-line"'))),
			).toMatch(/^Split it across three threads\.\s*$/);
			expect(html).toContain('data-event="needs-you"');
			expect(html).toContain('data-reference="pull-request"');
			expect(html).not.toContain('data-event="failed"');
			expect(html).not.toContain("::finished");
			expect(html).toContain('title="All 3 threads finished"');
		}
	});
	it("draws a long event line as a left-aligned status paragraph", () => {
		const id = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
		const html = render(
			`::failed [Bug-fix agent](thread:${id}) failed on its last turn. It had planned six bug fixes and regression tests.`,
		);
		expect(html).not.toContain("session-event-line");
		expect(html).toMatch(
			/^<div[^>]*><p class="session-status-paragraph" data-event="failed"><svg[^>]*session-status-icon/,
		);
		expect(html).toContain('data-reference="thread"');
		expect(textOf(html)).toMatch(/^Bug-fix agent failed on its last turn\./);
	});
	it("draws :status: paragraphs as prose with a status icon in front", () => {
		const id = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
		for (const streaming of [false, true]) {
			const html = render(
				`Here is where things stand.\n:needs-you: [Fix sign-up form](thread:${id}) needs you to merge pr:acme/web#8.\n:finished: Two more finished.\n\n\`:failed: in code\``,
				streaming,
			);
			const paragraphs = [
				...html.matchAll(
					/<p class="session-status-paragraph" data-event="([^"]+)">(.*?)<\/p>/g,
				),
			].map((match) => [match[1], textOf(match[2] ?? "")]);
			expect(paragraphs).toEqual([
				["needs-you", "Fix sign-up form needs you to merge web#8."],
				["finished", "Two more finished."],
			]);
			expect(textOf(html)).toContain(":failed: in code");
			expect(textOf(html)).not.toContain(":needs-you:");
		}
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

describe("pull request, issue and thread mentions", () => {
	const id = "3f9a1c2e-0000-4000-8000-000000000001";
	const renderIn = (text: string) =>
		renderToStaticMarkup(
			createElement(
				ReferenceContext.Provider,
				{
					value: {
						defaultRepository: "acme/web",
						pullRequests: new Set(["acme/web#8"]),
						threads: new Map([["WEB-3F9A", { id, title: "Fix sign-up form" }]]),
					},
				},
				createElement(AgentMarkdown, { text, onOpenFile: () => {} }),
			),
		);

	it("draws #8 as a PR chip when the project lists that pull request, else as an issue chip", () => {
		const html = renderIn("See #8 and #9, also acme/web#8.");
		expect(html.match(/data-reference="pull-request"/g)).toHaveLength(2);
		expect(html.match(/data-reference="issue"/g)).toHaveLength(1);
		expect(html).toContain('href="https://github.com/acme/web/pull/8"');
		expect(html).toContain('href="https://github.com/acme/web/issues/9"');
		expect(html).toContain('<span class="reference-chip-label">#8</span>');
		expect(html).toContain('<span class="reference-chip-label">#9</span>');
	});

	it("draws GitHub issue URLs as issue chips and other repositories' numbers with their name", () => {
		const html = renderIn(
			"[bug](https://github.com/acme/web/issues/5) and org/lib#3",
		);
		expect(html).toContain('data-ref="acme/web#5"');
		expect(html).toContain('<span class="reference-chip-label">lib#3</span>');
	});

	it("draws a thread's label as a chip that opens the thread", () => {
		const html = renderIn(
			"WEB-3F9A fixes it; WEB-0000 is not a thread. [x](thread:" + id + ")",
		);
		expect(html.match(/data-reference="thread"/g)).toHaveLength(2);
		expect(html).toContain('href="/thread/' + id + '"');
		expect(html).toContain("Fix sign-up form");
		expect(html).toContain("WEB-0000 is not a thread");
	});

	it("leaves numbers in code and bare numbers without a project alone", () => {
		expect(renderIn("`#8`")).not.toContain("reference-chip");
		const bare = render("fixes #8");
		expect(bare).not.toContain("reference-chip");
	});
});
