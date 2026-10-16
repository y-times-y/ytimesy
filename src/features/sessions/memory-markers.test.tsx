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
		expect(html).toContain("Recalled 2 memories");
		expect(html).toContain("Loaded memory index");
		expect(html).toContain("Uses pnpm, never npm");
		expect(html).toContain("tooling.md");
		expect(html).toContain(`href="/?chat=${OTHER}"`);
		expect(html).toContain("Monorepo setup");
		expect(html).toContain("Oct 12, 2026");
		expect(html).not.toMatch(EMOJI);
	});

	it("says only that the index loaded when no line was recalled, and nothing when empty", () => {
		expect(
			renderToStaticMarkup(
				<MemoryRecallNote recall={{ head: "h1", index: true, lines: [] }} />,
			),
		).toContain("Loaded memory index");
		expect(
			renderToStaticMarkup(
				<MemoryRecallNote recall={{ head: "h1", lines: [] }} />,
			),
		).toBe("");
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
		expect(html).toContain("Saved to memory: “Runs tests with vitest”");
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
	expect(html).toContain("Recalled 1 memory");
	expect(html).toContain("Saved to memory: “Uses date-fns”");
	expect(html.indexOf("Installed.")).toBeLessThan(
		html.indexOf("Saved to memory"),
	);
});
