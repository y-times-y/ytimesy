import { describe, expect, it } from "vitest";
import { applyApiProgress } from "./api-progress";
import {
	CANVAS_CHAT_BUDGET,
	CANVAS_CSP,
	CANVAS_HTML_LIMIT,
	CANVAS_SANDBOX,
	canvasDocument,
	canvasStandalonePage,
	chatCanvases,
	latestCanvasRevision,
	shownCanvas,
	withBoundedCanvasHistory,
} from "./canvas";
import { SessionItemId } from "./ids";
import type { CanvasItem, SessionItem } from "./session-item";
import { turnMayHaveChangedWorkspace } from "./turn-saving";

const canvas = (
	id: string,
	title: string,
	revision: number,
	html: string | null = `<p>${title} ${revision}</p>`,
): CanvasItem => ({
	kind: "canvas",
	id: SessionItemId(id),
	title,
	revision,
	html,
});

describe("canvasDocument", () => {
	it("puts the offline policy before the document's own markup", () => {
		const document = canvasDocument("<script>fetch('/api')</script>");
		expect(document.indexOf("Content-Security-Policy")).toBeLessThan(
			document.indexOf("<script>"),
		);
		expect(document).toContain(CANVAS_CSP);
	});

	it("keeps a leading doctype first so the page stays in standards mode", () => {
		const document = canvasDocument(
			"<!-- mockup -->\n<!DOCTYPE html><html><head></head></html>",
		);
		expect(document.startsWith("<!-- mockup -->\n<!DOCTYPE html><meta")).toBe(
			true,
		);
	});

	it("allows no network: no connect, remote script, image, font or form target", () => {
		expect(CANVAS_CSP).toContain("default-src 'none'");
		expect(CANVAS_CSP).toContain("connect-src 'none'");
		expect(CANVAS_CSP).toContain("form-action 'none'");
		expect(CANVAS_CSP).not.toMatch(/https?:/);
	});

	it("sandboxes scripts into an opaque origin", () => {
		expect(CANVAS_SANDBOX).toBe("allow-scripts");
		expect(CANVAS_SANDBOX).not.toContain("allow-same-origin");
	});
});

describe("canvasStandalonePage", () => {
	it("holds the canvas in a sandboxed frame with its markup escaped", () => {
		const page = canvasStandalonePage(
			'A "quoted" <title>',
			'<script>alert("x")</script>',
		);
		expect(page).toContain(`sandbox="${CANVAS_SANDBOX}"`);
		expect(page).not.toContain("allow-same-origin");
		// The canvas's script never appears as markup of the page itself.
		expect(page).not.toContain("<script>");
		expect(page).toContain("&lt;script&gt;alert(&quot;x&quot;)");
		expect(page).toContain("A &quot;quoted&quot; &lt;title&gt;");
	});
});

describe("shownCanvas", () => {
	it("reads a successful result and refuses failed or malformed ones", () => {
		const output = { shown: true, title: " Plan ", revision: 2, html: "<p/>" };
		expect(shownCanvas(output, false)).toEqual({
			shown: true,
			title: "Plan",
			revision: 2,
			html: "<p/>",
		});
		expect(shownCanvas(output, true)).toBeNull();
		expect(shownCanvas({ ...output, revision: 0 }, false)).toBeNull();
		expect(shownCanvas({ ...output, html: 1 }, false)).toBeNull();
		expect(shownCanvas("Shown", false)).toBeNull();
	});

	it("bounds the stored document", () => {
		const shown = shownCanvas(
			{
				shown: true,
				title: "Big",
				revision: 1,
				html: "x".repeat(CANVAS_HTML_LIMIT + 10),
			},
			false,
		);
		expect(shown?.html).toHaveLength(CANVAS_HTML_LIMIT);
	});
});

describe("revisions", () => {
	it("numbers revisions per title and groups them by canvas", () => {
		const items: SessionItem[] = [
			canvas("a", "Mockup", 1),
			canvas("b", "Chart", 1),
			canvas("c", "Mockup", 2),
		];
		expect(latestCanvasRevision(items, "Mockup")).toBe(2);
		expect(latestCanvasRevision(items, "  Mockup ")).toBe(2);
		expect(latestCanvasRevision(items, "New")).toBe(0);
		const threads = chatCanvases(items);
		// The most recently updated canvas comes last.
		expect(threads.map((thread) => thread.title)).toEqual(["Chart", "Mockup"]);
		expect(threads[1].revisions.map((entry) => entry.revision)).toEqual([1, 2]);
	});
});

describe("withBoundedCanvasHistory", () => {
	it("drops the oldest revisions' HTML first and keeps every canvas's newest", () => {
		const big = "x".repeat(CANVAS_HTML_LIMIT);
		const items: SessionItem[] = [
			canvas("1", "Other", 1, big),
			canvas("2", "Page", 1, big),
			canvas("3", "Page", 2, big),
			canvas("4", "Page", 3, big),
			canvas("5", "Page", 4, big),
		];
		const bounded = withBoundedCanvasHistory(items);
		const kept = (bounded as CanvasItem[]).map((item) => item.html !== null);
		// The chat holds four documents: both newest, then the newer of the rest.
		expect(kept).toEqual([true, false, true, true, true]);
		const total = (bounded as CanvasItem[]).reduce(
			(sum, item) => sum + (item.html?.length ?? 0),
			0,
		);
		expect(total).toBeLessThanOrEqual(CANVAS_CHAT_BUDGET);
	});

	it("leaves a chat within its budget as it is", () => {
		const items: SessionItem[] = [canvas("1", "A", 1), canvas("2", "A", 2)];
		expect(withBoundedCanvasHistory(items)).toEqual(items);
	});
});

describe("applyApiProgress", () => {
	it("shows the call by its title, then replaces it with the canvas", () => {
		const html = "<!doctype html><h1>Hi</h1>";
		const started = applyApiProgress([], "turn", {
			type: "tool-call",
			id: "call",
			name: "canvas",
			input: { title: "Landing page", html },
		});
		expect(started).toEqual([
			expect.objectContaining({
				kind: "dynamicToolCall",
				tool: "canvas",
				status: "inProgress",
			}),
		]);
		// The whole document is not copied into the call's card.
		expect(JSON.stringify(started)).not.toContain("<h1>");
		const shown = applyApiProgress(started, "turn", {
			type: "tool-result",
			id: "call",
			name: "canvas",
			output: { shown: true, title: "Landing page", revision: 1, html },
		});
		expect(shown).toEqual([
			{
				kind: "canvas",
				id: "turn:call",
				title: "Landing page",
				revision: 1,
				html,
			},
		]);
		// Showing a canvas is not a workspace change to commit.
		expect(turnMayHaveChangedWorkspace(shown, "turn")).toBe(false);
	});

	it("leaves a refused call as a failed tool call", () => {
		const started = applyApiProgress([], "turn", {
			type: "tool-call",
			id: "call",
			name: "canvas",
			input: { title: "X" },
		});
		const failed = applyApiProgress(started, "turn", {
			type: "tool-result",
			id: "call",
			name: "canvas",
			output: "Pass exactly one of html or path.",
			failed: true,
		});
		expect(failed).toEqual([
			expect.objectContaining({
				kind: "dynamicToolCall",
				status: "failed",
				output: expect.stringContaining("exactly one"),
			}),
		]);
		expect(turnMayHaveChangedWorkspace(failed, "turn")).toBe(false);
	});
});
