import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionItemId } from "#/domain/ids";
import type { MemorySaveItem, SessionItem } from "#/domain/session-item";
import {
	MemoryMarkerProvider,
	MemoryRecallNote,
	MemorySaveNote,
} from "./memory-markers";
import { SessionTimeline } from "./session-timeline";

const OTHER = "22222222-2222-4222-8222-222222222222";
/** Pictographs and other emoji; the markers are plain text only. */
const EMOJI = /\p{Extended_Pictographic}/u;

const actions = {
	onOpenMemory: () => {},
	onOpenChat: () => true,
	holds: () => true,
	onUndo: async () => ({ removed: true }),
};

describe("recalled memory under a request", () => {
	it("is a collapsed count that lists each line, its file and source chat", () => {
		const html = renderToStaticMarkup(
			<MemoryMarkerProvider actions={actions}>
				<MemoryRecallNote
					recall={{
						head: "h1",
						index: true,
						lines: [
							{
								path: "tooling.md",
								text: "Uses pnpm, never npm",
								source: {
									chatId: OTHER,
									title: "Monorepo setup",
									date: "2026-10-12",
								},
							},
							{ path: "style.md", text: "Prefers tabs" },
						],
					}}
				/>
			</MemoryMarkerProvider>,
		);
		expect(html).toContain("<details");
		expect(html).not.toContain("open=");
		// The index counts too: everything the request put in context.
		expect(html).toContain("Used 3 memories");
		expect(html).toContain('title="Index · 2 matches"');
		expect(html).toContain("MEMORY.md");
		expect(html).toContain("Uses pnpm, never npm");
		expect(html).toContain("tooling.md");
		expect(html).toContain(`href="/?chat=${OTHER}"`);
		expect(html).toContain("Monorepo setup");
		expect(html).toContain("Oct 12, 2026");
		expect(html).not.toMatch(EMOJI);
	});

	it("counts the index alone when no line was recalled, and shows nothing when empty", () => {
		const html = renderToStaticMarkup(
			<MemoryRecallNote
				recall={{ head: "h1", index: true, indexLines: 6, lines: [] }}
			/>,
		);
		expect(html).toContain("Used 1 memory");
		expect(html).toContain('title="Index (6 lines)"');
		expect(
			renderToStaticMarkup(
				<MemoryRecallNote recall={{ head: "h1", lines: [] }} />,
			),
		).toBe("");
	});
});

describe("memory marker layout", () => {
	it("groups the rules, the matched lines and other chats' messages, all counted", () => {
		const html = renderToStaticMarkup(
			<MemoryRecallNote
				recall={{
					head: "h1",
					lines: [
						{
							path: "rules.md",
							text: "Every file starts with a license header",
							rule: true,
						},
						{ path: "tooling.md", text: "Uses pnpm" },
					],
					recent: [
						{
							chatId: OTHER,
							title: "Billing",
							text: "Prices are in cents from now on",
						},
					],
				}}
			/>,
		);
		expect(html).toContain("Used 3 memories");
		expect(html).toContain('title="1 rule · 1 match · 1 chat message"');
		expect(html).toContain('aria-label="Project rules"');
		expect(html).toContain('aria-label="Matched this request"');
		expect(html).toContain('aria-label="From other chats"');
		expect(html).toContain("Prices are in cents from now on");
		expect(html).toContain(`href="/?chat=${OTHER}"`);
		expect(html.indexOf("Uses pnpm")).toBeLessThan(html.indexOf("Prices are"));
		expect(html.indexOf("license header")).toBeLessThan(
			html.indexOf("Uses pnpm"),
		);
		expect(html).toMatch(/class="[^"]*memory-marker-icon/);
		expect(html).not.toMatch(EMOJI);
	});

	it("names no groups when nothing is a project rule", () => {
		const html = renderToStaticMarkup(
			<MemoryRecallNote
				recall={{ head: "h1", lines: [{ path: "a.md", text: "Short" }] }}
			/>,
		);
		expect(html).not.toContain("Project rules");
		expect(html).not.toContain("Matched this request");
		expect(html).toContain("Used 1 memory");
	});

	it("clips a long line with a More control instead of a wall of text", () => {
		const long = `Always ${"run the whole suite before pushing ".repeat(8)}`;
		const html = renderToStaticMarkup(
			<MemoryRecallNote
				recall={{ head: "h1", lines: [{ path: "a.md", text: long }] }}
			/>,
		);
		expect(html).not.toContain(long);
		expect(html).toContain("…");
		expect(html).toContain('aria-expanded="false"');
		expect(html).toContain(">More</button>");
	});
});

describe("saved memory after a turn", () => {
	const one: MemorySaveItem = {
		kind: "memorySave",
		id: SessionItemId("t:memory-saved"),
		lines: [{ path: "tooling.md", text: "Runs tests with vitest" }],
	};

	it("shows a single line with Undo and a link to the Memory tab", () => {
		const html = renderToStaticMarkup(
			<MemoryMarkerProvider actions={actions}>
				<MemorySaveNote item={one} />
			</MemoryMarkerProvider>,
		);
		expect(html).toContain("Saved 1 memory");
		expect(html).toContain("<details");
		expect(html).not.toContain("open=");
		expect(html).toContain("Runs tests with vitest");
		expect(html).toContain(">Undo</button>");
		expect(html).toContain(">Open in Memory</button>");
		expect(html).not.toMatch(EMOJI);
	});

	it("collapses several lines behind a count", () => {
		const html = renderToStaticMarkup(
			<MemoryMarkerProvider actions={actions}>
				<MemorySaveNote
					item={{
						...one,
						lines: [...one.lines, { path: "db.md", text: "Prefers Postgres" }],
					}}
				/>
			</MemoryMarkerProvider>,
		);
		expect(html).toContain("Saved 2 memories");
		expect(html.match(/>Undo</g)).toHaveLength(2);
	});

	it("offers no Undo for a line memory no longer holds", () => {
		const html = renderToStaticMarkup(
			<MemoryMarkerProvider actions={{ ...actions, holds: () => false }}>
				<MemorySaveNote item={one} />
			</MemoryMarkerProvider>,
		);
		expect(html).toContain("No longer in memory");
		expect(html).not.toContain(">Undo<");
	});
});

it("renders the request as typed, with recalled memory as a separate muted note", () => {
	const items: SessionItem[] = [
		{
			kind: "userMessage",
			id: SessionItemId("a"),
			text: "install a date library",
			memory: {
				head: "h1",
				lines: [{ path: "tooling.md", text: "Uses pnpm" }],
			},
		},
		{ kind: "agentMessage", id: SessionItemId("t:a"), text: "Installed." },
		{
			kind: "memorySave",
			id: SessionItemId("t:memory-saved"),
			lines: [{ path: "tooling.md", text: "Uses date-fns" }],
		},
	];
	const html = renderToStaticMarkup(
		<SessionTimeline
			items={items}
			turnStatus="completed"
			memoryActions={actions}
		/>,
	);
	expect(html).toContain("<p>install a date library</p>");
	expect(html).not.toContain("&lt;memory&gt;");
	expect(html).toContain("Used 1 memory");
	expect(html).toContain("Saved 1 memory");
	expect(html.indexOf("Installed.")).toBeLessThan(
		html.indexOf("Saved 1 memory"),
	);
});
