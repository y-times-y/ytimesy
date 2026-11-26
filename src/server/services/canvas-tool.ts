import { posix } from "node:path";
import { type ToolSet, tool } from "ai";
import { z } from "zod";
import {
	CANVAS_HTML_LIMIT,
	CANVAS_TITLE_LIMIT,
	CANVAS_TOOL,
	type CanvasToolResult,
	canvasConfirmation,
	canvasTitle,
	latestCanvasRevision,
} from "#/domain/canvas";
import type { SessionItem } from "#/domain/session-item";
import { redactToolText } from "#/domain/tool-detail";
import type { AgentToolWorkspace } from "./agent-tool-workspace";

const DESCRIPTION = `Open a design canvas the user and you iterate on together: a self-contained HTML document shown as a card in the conversation and live beside the chat, where the user zooms and pans it like a design tool's canvas (it opens fitted to the panel), pins notes on its elements, and compares revisions side by side.
Only for a large standalone page or document: not for anything that fits in a message. Charts, stat cards, tables, timelines, checklists and small diagrams go inline, as a fenced \`\`\`artifact block in your reply (see the Artifacts instructions).
Use it to work on a design with the user:
- UI mockups and clickable prototypes before you build a frontend change, and the built page after (with path, the real file).
- Exploration: put two or three options side by side in ONE canvas, each clearly labelled (Option A, B, C) with a one-line rationale, so the user can compare and point at parts of each.
- Layout, visual and copy options, user flows (screens in a row), and comparisons such as before/after or screenshots side by side.
Iterating:
- Keep the same title for the same design: each call adds the next revision, the user steps between and compares them. Use a new title only for a different artifact. Keep titles short and stable, e.g. "Pricing page".
- The user's pinned notes arrive as one message starting "Canvas feedback on "<title>" (revision N)", each note with the element it is on (tag, text and CSS selector). Apply every note, then call this tool again with the same title; in your reply, say briefly what changed per note.
- To let the user choose with one click, add buttons with data-ytimesy-prompt="Go with option B" (at most 500 characters): clicking one puts that text in the user's message box (they still press send). Use them for picking an option or a next step.
Rules:
- One complete document (<!doctype html>…) with all CSS, JavaScript, fonts and images inline (images as data: URIs or inline SVG). The preview is offline and sandboxed: it cannot load any URL (no CDN scripts or stylesheets, web fonts, remote images, fetch or forms), and has no cookies or storage. Bundle a framework build into one file (for example vite-plugin-singlefile) before showing it.
- Pass html for a short document; for anything larger, or to show what you built, write the file and pass path (a .html file in the workspace), which keeps the document out of the conversation.
- Never type or copy base64, binary or other long encoded data into html by hand: one wrong character shows a broken image. Build such a document with a script that reads the real files and writes the .html, check that it renders, then pass path.
- The viewer is an infinite canvas: it measures your document and fits it to the panel, so never design for the panel's width (the panel can be narrow) and never rely on the viewport. Lay the page out wide, and put each design on its own artboard: an element with a fixed pixel size at its real size (a page at 1440 px wide, a sidebar at 300x760, a phone at 390x844) and the attribute data-artboard, side by side in a row (display: flex; gap: 48px; flex-wrap: nowrap; padding: 48px) with a short label above each. The viewer fits all artboards on open; without any, it fits the document's own size, laid out 1280 px wide.
- Design for a dark or light background deliberately, give elements meaningful text and ids (notes point at them), and use realistic content instead of lorem ipsum.
- The user sees the canvas, not your HTML: do not paste the HTML into your reply; say what to look at and what to decide.
- The result is a short confirmation (title, revision, size, where the user sees it), never the document back.
At most ${CANVAS_HTML_LIMIT.toLocaleString("en-US")} characters.`;

/**
 * The canvas tool (src/domain/canvas.ts). The chat's item is made from its
 * result (applyApiProgress); the model reads only a short confirmation
 * (toModelOutput), in the API harness and over MCP (mcp-tool-call.ts) alike.
 */
export function canvasTools(input: {
	/** The chat's items now, to number revisions. */
	readonly items: () => readonly SessionItem[];
	/** The workspace a `path` is read from. */
	readonly workspace: () => Promise<AgentToolWorkspace>;
	/**
	 * The highest revision of a title saved in the chat. `items` holds only
	 * the active turn, so without this each new turn would number from 1.
	 */
	readonly savedRevision?: (title: string) => Promise<number>;
}): ToolSet {
	// Revisions issued in this turn and not yet in the items (parallel calls).
	const issued = new Map<string, number>();
	return {
		[CANVAS_TOOL]: tool({
			description: DESCRIPTION,
			inputSchema: z.object({
				title: z
					.string()
					.min(1)
					.max(CANVAS_TITLE_LIMIT)
					.describe(
						"A short, stable name; the same title updates that canvas.",
					),
				html: z
					.string()
					.optional()
					.describe("A complete self-contained HTML document."),
				path: z
					.string()
					.optional()
					.describe(
						"A .html file in the workspace to show instead of html, relative to the repository root or absolute.",
					),
			}),
			execute: async ({ title, html, path }): Promise<CanvasToolResult> => {
				const name = canvasTitle(title);
				if (!name) throw new Error("Give the canvas a title.");
				if ((html === undefined) === (path === undefined))
					throw new Error("Pass exactly one of html or path.");
				const source: { html: string; path?: string } =
					path === undefined
						? { html: html as string }
						: await readCanvasFile(await input.workspace(), path);
				if (!source.html.trim()) throw new Error("The document is empty.");
				if (source.html.length > CANVAS_HTML_LIMIT)
					throw new Error(
						`The document has ${source.html.length.toLocaleString("en-US")} characters; a canvas holds at most ${CANVAS_HTML_LIMIT.toLocaleString("en-US")}. Inline less (smaller images, minified code) or split it into several canvases.`,
					);
				// Read the saved number first: nothing awaits between taking the
				// next revision and recording it, so parallel calls get distinct ones.
				const saved = (await input.savedRevision?.(name)) ?? 0;
				const revision =
					Math.max(
						latestCanvasRevision(input.items(), name),
						issued.get(name) ?? 0,
						saved,
					) + 1;
				issued.set(name, revision);
				return {
					shown: true,
					title: name,
					revision,
					// Project secret values are redacted by the turn's wrapper.
					html: redactToolText(source.html),
					...(source.path ? { path: source.path } : {}),
				};
			},
			// The model wrote the document; it needs only the confirmation.
			toModelOutput: ({ output }) => {
				const shown = output as CanvasToolResult;
				return {
					type: "text",
					value: canvasConfirmation(shown),
				};
			},
		}),
	};
}

/** A workspace .html file, by a path relative to the repository or absolute. */
export async function readCanvasFile(
	workspace: AgentToolWorkspace,
	path: string,
): Promise<{ html: string; path: string }> {
	const trimmed = path.trim();
	if (!/\.html?$/i.test(trimmed))
		throw new Error("path must name an .html file.");
	const absolute = posix.resolve(workspace.cwd, trimmed);
	const html = await workspace.machines.readTextFile(workspace.vm, absolute);
	if (html === null) throw new Error(`No file at ${trimmed}.`);
	const relative = posix.relative(workspace.cwd, absolute);
	return {
		html,
		path: relative && !relative.startsWith("..") ? relative : absolute,
	};
}
