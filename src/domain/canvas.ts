import { CANVAS_BRIDGE_SCRIPT } from "./canvas-annotation";
import { SessionItemId } from "./ids";
import type { CanvasItem, SessionItem } from "./session-item";

/**
 * The canvas: a surface where the agent and the user iterate on a design.
 * The agent shows a self-contained HTML document (UI mockups, layout and
 * visual options side by side, flows) with the `canvas` tool; the chat
 * shows a card and the right panel's Canvas view renders it in a sandboxed
 * frame, where the user pins notes on elements and sends them back
 * (canvas-annotation.ts). Calling again with the same title adds the next
 * revision, which the user can compare with the last.
 */
export const CANVAS_TOOL = "canvas";

/**
 * Y²'s tool that places a canvas one of its threads showed into Y²'s own
 * chat (the Super agent chat), so the person sees and annotates it there.
 */
export const SHOW_CANVAS_TOOL = "show_canvas";

/** The tools whose result becomes a canvas card in the chat. */
export const isCanvasDisplayTool = (name: string) =>
	name === CANVAS_TOOL || name === SHOW_CANVAS_TOOL;

export const CANVAS_TITLE_LIMIT = 60;

/** The most characters one canvas document may have (about 500 KB). */
export const CANVAS_HTML_LIMIT = 500_000;

/**
 * The most canvas HTML one chat keeps, in characters. Every revision is
 * listed, but once newer ones fill this budget an older revision keeps only
 * its title and number (its `html` becomes null), so a chat full of
 * revisions stays a bounded record.
 */
export const CANVAS_CHAT_BUDGET = 2_000_000;

/**
 * The frame's sandbox: scripts run, but in an opaque origin (no
 * allow-same-origin), so the document cannot read the app's cookies or
 * storage, call its API with the user's session, or reach the parent page.
 * No forms, popups, modals, downloads or top-level navigation.
 */
export const CANVAS_SANDBOX = "allow-scripts";

/**
 * The policy put at the top of every canvas document. Offline: everything
 * must be inline or a data:/blob: URL, so a canvas cannot load remote code,
 * beacon out what it shows, or track that the user opened it. connect-src
 * blocks fetch, XHR, WebSocket and EventSource; form-action, base-uri and
 * frame-src close the remaining ways out.
 */
export const CANVAS_CSP = [
	"default-src 'none'",
	"script-src 'unsafe-inline' 'unsafe-eval' data: blob:",
	"style-src 'unsafe-inline' data: blob:",
	"img-src data: blob:",
	"font-src data: blob:",
	"media-src data: blob:",
	"worker-src blob:",
	"connect-src 'none'",
	"form-action 'none'",
	"base-uri 'none'",
	"frame-src 'none'",
].join("; ");

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${CANVAS_CSP}">`;

/** A leading doctype (after comments and whitespace), which must stay first. */
const LEADING_DOCTYPE = /^(?:\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/i;

/**
 * The document the frame renders: the agent's HTML with the policy first,
 * then the bridge the Canvas view annotates through. A policy element read
 * before any of the document's own markup applies to all of it (the bridge
 * included), and removing the element later does not lift it.
 */
export function canvasDocument(html: string): string {
	const head = `${CSP_META}${CANVAS_BRIDGE_SCRIPT}`;
	const doctype = LEADING_DOCTYPE.exec(html);
	if (!doctype) return `${head}${html}`;
	const end = doctype[0].length;
	return `${html.slice(0, end)}${head}${html.slice(end)}`;
}

function attributeText(value: string) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

/**
 * A page that shows one canvas full-window for "Open in new tab". The page
 * itself has no script; the canvas runs inside it in the same sandboxed
 * frame as in the panel, so the new tab's (app-origin blob) page never runs
 * the canvas's code.
 */
export function canvasStandalonePage(title: string, html: string): string {
	return `<!doctype html><html><head><meta charset="utf-8">${CSP_META}<title>${attributeText(title)}</title><style>html,body{margin:0;height:100%;background:#fff}iframe{border:0;width:100%;height:100%;display:block}</style></head><body><iframe sandbox="${CANVAS_SANDBOX}" referrerpolicy="no-referrer" title="${attributeText(title)}" srcdoc="${attributeText(canvasDocument(html))}"></iframe></body></html>`;
}

/** A canvas's identity: its title, trimmed and with runs of whitespace as one space. */
export function canvasTitle(title: string): string {
	return title.trim().replace(/\s+/g, " ");
}

/** The highest revision a canvas with this title has in the chat (0 when new). */
export function latestCanvasRevision(
	items: readonly SessionItem[],
	title: string,
): number {
	const key = canvasTitle(title);
	let latest = 0;
	for (const item of items)
		if (item.kind === "canvas" && item.title === key && item.revision > latest)
			latest = item.revision;
	return latest;
}

/** What a successful canvas call returns (and the event the chat's item is made from). */
export type CanvasToolResult = {
	readonly shown: true;
	readonly title: string;
	readonly revision: number;
	readonly html: string;
	/** The workspace file it was read from, when the agent passed a path. */
	readonly path?: string;
	/** Y²'s show_canvas: the thread that owns the canvas, and its item there. */
	readonly ownerThreadId?: string;
	readonly ownerItemId?: string;
};

/** The canvas a tool result shows, or null for a failed or malformed one. */
export function shownCanvas(
	value: unknown,
	failed: boolean | undefined,
): CanvasToolResult | null {
	const output = value as Partial<CanvasToolResult> | null;
	if (failed || output?.shown !== true) return null;
	if (
		typeof output.title !== "string" ||
		typeof output.html !== "string" ||
		typeof output.revision !== "number" ||
		!Number.isInteger(output.revision) ||
		output.revision < 1
	)
		return null;
	const title = canvasTitle(output.title).slice(0, CANVAS_TITLE_LIMIT);
	if (!title) return null;
	return {
		shown: true,
		title,
		revision: output.revision,
		html: output.html.slice(0, CANVAS_HTML_LIMIT),
		...(typeof output.path === "string" ? { path: output.path } : {}),
		...(typeof output.ownerThreadId === "string" && output.ownerThreadId
			? { ownerThreadId: output.ownerThreadId.slice(0, 64) }
			: {}),
		...(typeof output.ownerItemId === "string" && output.ownerItemId
			? { ownerItemId: output.ownerItemId.slice(0, 128) }
			: {}),
	};
}

/** The chat's item for a shown canvas. */
export function canvasItem(
	id: SessionItemId | string,
	shown: CanvasToolResult,
): CanvasItem {
	return {
		kind: "canvas",
		id: SessionItemId(id),
		title: shown.title,
		revision: shown.revision,
		html: shown.html,
		...(shown.path ? { path: shown.path } : {}),
		...(shown.ownerThreadId ? { ownerThreadId: shown.ownerThreadId } : {}),
		...(shown.ownerItemId ? { ownerItemId: shown.ownerItemId } : {}),
	};
}

/**
 * Items with older canvas revisions' HTML dropped once the newer ones use
 * the chat's budget (CANVAS_CHAT_BUDGET). The newest revision of each canvas
 * is kept first, so every canvas still opens; older revisions fill what is
 * left, newest first.
 */
export function withBoundedCanvasHistory(
	items: readonly SessionItem[],
): SessionItem[] {
	const canvases = items
		.map((item, index) => ({ item, index }))
		.filter(
			(entry): entry is { item: CanvasItem; index: number } =>
				entry.item.kind === "canvas" && entry.item.html !== null,
		);
	const latestIndex = new Map<string, number>();
	for (const { item, index } of canvases) latestIndex.set(item.title, index);
	const order = [...canvases].sort((a, b) => {
		const aLatest = latestIndex.get(a.item.title) === a.index ? 0 : 1;
		const bLatest = latestIndex.get(b.item.title) === b.index ? 0 : 1;
		return aLatest - bLatest || b.index - a.index;
	});
	let used = 0;
	const dropped = new Set<number>();
	for (const { item, index } of order) {
		const size = item.html?.length ?? 0;
		if (used + size > CANVAS_CHAT_BUDGET) dropped.add(index);
		else used += size;
	}
	if (!dropped.size) return [...items];
	return items.map((item, index) =>
		dropped.has(index) && item.kind === "canvas"
			? { ...item, html: null }
			: item,
	);
}

/** One canvas in a chat: its title and its revisions, oldest first. */
export type CanvasThread = {
	readonly title: string;
	readonly revisions: readonly CanvasItem[];
};

/** The chat's canvases, most recently updated last. */
export function chatCanvases(items: readonly SessionItem[]): CanvasThread[] {
	const byTitle = new Map<string, CanvasItem[]>();
	for (const item of items) {
		if (item.kind !== "canvas") continue;
		const revisions = byTitle.get(item.title) ?? [];
		// A re-read item (same id) replaces its earlier copy.
		const same = revisions.findIndex((entry) => entry.id === item.id);
		if (same >= 0) revisions.splice(same, 1);
		revisions.push(item);
		byTitle.delete(item.title);
		byTitle.set(item.title, revisions);
	}
	return [...byTitle].map(([title, revisions]) => ({
		title,
		revisions: inOrder(revisions),
	}));
}

/**
 * Revisions oldest first, in the order the chat saved them. Numbers that
 * repeat or run backwards (a chat from when each turn restarted at
 * revision 1) are renumbered 1, 2, 3, so the newest is always the last and
 * every number is unique for the stepper and for notes.
 */
function inOrder(revisions: readonly CanvasItem[]): CanvasItem[] {
	const ordered = revisions.every(
		(entry, index) =>
			index === 0 || entry.revision > revisions[index - 1].revision,
	);
	return ordered
		? [...revisions]
		: revisions.map((entry, index) => ({ ...entry, revision: index + 1 }));
}

/** The few lines of system guidance; the tool's description has the rules. */
export function canvasInstructions(toolName: string = CANVAS_TOOL): string {
	return `Canvas vs inline: prefer an inline artifact for anything that fits in a message (a chart, stat card, table, timeline, checklist or small diagram: a fenced \`\`\`artifact block in your reply, see Artifacts). The canvas is only for a large standalone page or document the user will iterate on (a full HTML page, a landing page mockup, a multi-screen flow, layout options side by side, a long report), or when the user asks for a canvas. "A chart of weekly signups" or "a dashboard of these numbers" is inline; "a landing page mockup" or "three layout options for the settings page" is a canvas.
Canvas: design with the user, don't describe. When ${toolName} is offered, use it to iterate on a design together: UI mockups, layout and visual options, flows, and comparisons (before/after, screenshots or options side by side). For exploration, put two or three labelled options (A/B/C) side by side in one canvas, with data-ytimesy-prompt buttons such as "Go with option B", and ask the user to pick or annotate. The user can pin notes on elements and send them as a "Canvas feedback on …" message: apply every note, then call ${toolName} again with the same title for the next revision (never a new title for the same design). When the canvas shows an existing UI (a component, a page, a change to one), show the real thing, not a drawing and not a browser-window screenshot: render the real component with the app's own compiled CSS and inline its markup, styles and assets (logo, icons) into one file by script. Design for the viewer: it is an infinite canvas where the user zooms and pans, and it opens fitted to the panel, so never assume the panel is wide and never rely on the viewer's width. Lay the artboards out on one wide page (a row with gaps, no wrapping), mark each artboard with the attribute data-artboard, and keep each at a realistic fixed size (a page 1440 px wide, a sidebar 300x760, a phone 390x844), with a short label above it; the viewer measures the artboards and fits them all. Give each variant its own artboard so fixed or absolute children cannot overlap, and set the page state the app relies on (for example the attributes on <html>). Before showing it, compare it with the real app: a preview without the app's CSS or assets shows what the user never sees (broken logos, screen-reader-only text, duplicate toggles, overlaps), and the user will rightly distrust the rest. Say what the canvas cannot reproduce (hover, scripts, live data). The user sees it beside the chat, so your reply only says what changed and what to look at.`;
}

/**
 * The model's short confirmation of a shown canvas: its title, revision,
 * size and source file, and where the user sees it. Never the HTML: a
 * canvas can be hundreds of KB, and the model wrote or chose it already.
 */
export function canvasConfirmation(
	shown: Pick<CanvasToolResult, "title" | "revision" | "html" | "path">,
): string {
	const kb = Math.round((shown.html.length / 1024) * 10) / 10;
	return `Shown to the user as canvas '${shown.title}' (revision ${shown.revision}), ${kb} KB${shown.path ? ` from ${shown.path}` : ""}: a card in this chat that opens in the Canvas panel beside it, where they preview it and pin notes.${inlineNudge(shown.html)}`;
}

/** The most characters of a canvas that could have been an inline artifact. */
const INLINE_NUDGE_LIMIT = 6_000;

/**
 * A short hint for the model (never the person) after it opened a canvas
 * that looks like a small chart, table or diagram: those belong inline. Not
 * for a real design (artboards, prompt buttons) or anything large.
 */
export function inlineNudge(html: string): string {
	if (html.length > INLINE_NUDGE_LIMIT) return "";
	if (/data-artboard|data-ytimesy-prompt|<form|<input|<button/i.test(html))
		return "";
	if (!/<svg|<table|<canvas|chart/i.test(html)) return "";
	return " This was small enough to show inline: next time put charts, tables, timelines, checklists and small diagrams in your reply as a ```artifact block (see Artifacts) and keep the canvas for large pages.";
}
