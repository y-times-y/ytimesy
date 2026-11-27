import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { threadDirectory } from "#/domain/thread-label";
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

	it("draws #8 as a PR chip when the project lists that pull request, else as a neutral number chip", () => {
		const html = renderIn("See #8 and #9, also acme/web#8.");
		expect(html.match(/data-reference="pull-request"/g)).toHaveLength(2);
		expect(html).not.toContain('data-reference="issue"');
		expect(html.match(/data-reference="number"/g)).toHaveLength(1);
		expect(html).toContain('href="https://github.com/acme/web/pull/8"');
		expect(html).toContain('<span class="reference-chip-label">#8</span>');
		expect(html).toContain('<span class="reference-chip-label">#9</span>');
		// The neutral chip has no issue or pull request icon.
		const neutral = /<a [^>]*data-reference="number"[^>]*>(.*?)<\/a>/.exec(
			html,
		);
		expect(neutral?.[1]).not.toContain("<svg");
	});

	describe("a bare number the project does not list", () => {
		const stored = new Map<string, string>();
		beforeEach(() => {
			stored.clear();
			vi.stubGlobal("sessionStorage", {
				getItem: (key: string) => stored.get(key) ?? null,
				setItem: (key: string, value: string) => stored.set(key, value),
			});
		});
		afterEach(() => vi.unstubAllGlobals());
		const renderLookedUp = (text: string) =>
			renderToStaticMarkup(
				createElement(
					QueryClientProvider,
					{ client: new QueryClient() },
					createElement(
						ReferenceContext.Provider,
						{
							value: {
								defaultRepository: "acme/web",
								pullRequests: new Set<string>(),
								repositories: new Map([
									["acme/web", { installationId: 1, repositoryId: 77 }],
								]),
							},
						},
						createElement(AgentMarkdown, { text, onOpenFile: () => {} }),
					),
				),
			);

		it("is a pull request chip when GitHub says the number is one", () => {
			stored.set("ytimesy:reference-kind:77#14", "pull-request");
			const html = renderLookedUp("Merged #14 and acme/web#14.");
			expect(html.match(/data-reference="pull-request"/g)).toHaveLength(2);
			expect(html).not.toContain('data-reference="issue"');
			expect(html).toContain('href="https://github.com/acme/web/pull/14"');
		});
		it("is an issue chip when GitHub says the number is an issue", () => {
			stored.set("ytimesy:reference-kind:77#3", "issue");
			const html = renderLookedUp("Fixes #3.");
			expect(html.match(/data-reference="issue"/g)).toHaveLength(1);
			expect(html).not.toContain('data-reference="pull-request"');
		});
		it("stays neutral until the type is known", () => {
			const html = renderLookedUp("See #9.");
			expect(html).toContain('data-reference="number"');
			expect(html).not.toContain('data-reference="issue"');
			expect(html).not.toContain('data-reference="pull-request"');
		});
		it("keeps the explicit forms and URLs as they are", () => {
			stored.set("ytimesy:reference-kind:77#5", "issue");
			const html = renderLookedUp(
				"pr:acme/web#5, issue:acme/web#5 and https://github.com/acme/web/pull/5",
			);
			expect(html.match(/data-reference="pull-request"/g)).toHaveLength(2);
			expect(html.match(/data-reference="issue"/g)).toHaveLength(1);
		});
	});

	it("draws every form of a pull request as a chip that the app opens (data-reference), whatever the project", () => {
		const html = renderIn(
			"pr:acme/web#45, https://github.com/acme/web/pull/45, [the PR](https://github.com/acme/web/pull/45/files), pr:other/lib#2 and https://github.com/other/lib/pull/2",
		);
		expect(html.match(/data-reference="pull-request"/g)).toHaveLength(5);
		expect(html).toContain('data-ref="acme/web#45"');
		// A repository the project does not have connected keeps its GitHub address;
		// whether a click opens the app is the workspace's decision (it opens GitHub).
		expect(html).toContain('href="https://github.com/other/lib/pull/2"');
		expect(html).toContain("the PR");
	});

	it("draws a bare number the project cannot place as a neutral chip the app still handles", () => {
		const html = renderIn("Pushed to draft PR #45.");
		expect(html).toContain('data-reference="number"');
		expect(html).toContain('data-ref="acme/web#45"');
	});

	it("draws GitHub issue URLs as issue chips and other repositories' numbers with their name", () => {
		const html = renderIn(
			"[bug](https://github.com/acme/web/issues/5) and org/lib#3",
		);
		expect(html).toContain('data-ref="acme/web#5"');
		expect(html).toContain('<span class="reference-chip-label">lib#3</span>');
	});

	it("draws a thread's readable name in a reply as a chip", () => {
		const html = renderToStaticMarkup(
			createElement(
				ReferenceContext.Provider,
				{
					value: {
						threads: threadDirectory("ytimesy", [
							{ id, title: "Fix sign-up form", threadNumber: 12 },
						]),
					},
				},
				createElement(AgentMarkdown, {
					text: "I asked ytimesy-12 to take it, not ytimesy-99.",
					onOpenFile: () => {},
				}),
			),
		);
		expect(html.match(/data-reference="thread"/g)).toHaveLength(1);
		expect(html).not.toContain("thread-art");
		// The chip shows the readable name, not the thread's old hex label.
		expect(html).toContain(">ytimesy-12</span>");
		expect(html).not.toMatch(/yti-[0-9a-f]{4}/i);
		expect(html).toContain("ytimesy-99");
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
