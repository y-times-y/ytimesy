import { tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { CanvasRead } from "../adapters/canvas-read";
import { canvasTools } from "./canvas-tool";
import { mcpToolDefinitions, runToolForMcp } from "./mcp-tool-call";
import { ySquaredTools } from "./y-squared-tools";

/**
 * What Claude Code reads from ytimesy's tools over MCP: the text the tool's
 * own model conversion gives (as the API harness's model reads it), never
 * the raw result the chat's item is made from.
 */

// A real canvas from production was 432 KB: mostly base64 screenshots.
const BIG_HTML = `<!doctype html><title>Sidebar</title><h1>Before and after</h1><img alt="Before" src="data:image/png;base64,${"A".repeat(420_000)}">`;

const run = (
	definition: unknown,
	name: string,
	args: Record<string, unknown>,
) =>
	runToolForMcp(definition as never, name, args, {
		toolCallId: "ccmcp-1",
		signal: new AbortController().signal,
	});

describe("the canvas tools in Claude Code's MCP tool list", () => {
	it("lists canvas, read_canvas and show_canvas with descriptions that promise a short result", async () => {
		const listed = await mcpToolDefinitions({
			...canvasTools({ items: () => [], workspace: vi.fn() as never }),
			...ySquaredTools({
				userId: "u",
				projectId: "p",
				selfId: "y2",
				items: () => [],
				deps: { crew: () => null, list: vi.fn() as never },
			}),
		});
		const byName = new Map(listed.map((entry) => [entry.name, entry]));
		expect(byName.get("canvas")?.description).toContain(
			"never the document back",
		);
		expect(byName.get("show_canvas")?.description).toContain(
			"never the document",
		);
		const read = byName.get("read_canvas");
		expect(read?.description).toContain("never the whole document");
		const properties = (
			read?.inputSchema as { properties: Record<string, { maximum?: number }> }
		).properties;
		expect(Object.keys(properties)).toEqual(
			expect.arrayContaining(["id", "title", "part", "offset", "limit"]),
		);
		expect(properties.limit?.maximum).toBe(20_000);
	});
});

describe("runToolForMcp", () => {
	it("answers the canvas tool with its short confirmation, never the document", async () => {
		const tools = canvasTools({
			items: () => [],
			workspace: vi.fn() as never,
		});
		const ran = await run(tools.canvas, "canvas", {
			title: "Sidebar: Threads only",
			html: BIG_HTML,
		});
		// The chat's item is still made from the whole result.
		expect((ran.output as { html: string }).html).toBe(BIG_HTML);
		const text = ran.reply.text;
		expect(ran.reply.isError).toBe(false);
		expect(text).toContain("canvas 'Sidebar: Threads only' (revision 1)");
		expect(text).toContain("KB");
		expect(text).not.toContain("<!doctype");
		expect(text).not.toContain("AAAA");
		expect(text.length).toBeLessThan(600);
	});

	it("answers Y²'s show_canvas with its confirmation, never the document", async () => {
		const read: CanvasRead = {
			itemId: "item-1",
			title: "Sidebar: Threads only",
			revision: 1,
			html: BIG_HTML,
			path: "/tmp/stp-shots/canvas.html",
			latestRevision: 1,
		};
		const tools = ySquaredTools({
			userId: "u",
			projectId: "p",
			selfId: "y2",
			items: () => [],
			deps: {
				canvas: (async () => read) as never,
				metadata: (async () => ({
					id: "t1",
					projectId: "p",
					title: "Sidebar",
					harness: "api",
					listedModelId: "m",
					parentSessionId: null,
					agentRole: null,
					turnStatus: "idle",
				})) as never,
				crew: () => null,
				list: vi.fn() as never,
			},
		});
		const ran = await run(tools.show_canvas, "show_canvas", {
			id: "t1",
			title: "Sidebar: Threads only",
		});
		expect((ran.output as { html: string }).html).toBe(BIG_HTML);
		expect(ran.reply.text).toContain("(revision 1)");
		expect(ran.reply.text).not.toContain("<!doctype");
		expect(ran.reply.text.length).toBeLessThan(600);
	});

	it("uses a tool's text, json and error conversions; a tool without one answers its result", async () => {
		const textTool = tool({
			inputSchema: z.object({}),
			execute: async () => ({ secret: "raw" }),
			toModelOutput: () => ({ type: "text", value: "short" }),
		});
		expect((await run(textTool, "t", {})).reply).toEqual({
			text: "short",
			isError: false,
		});
		const jsonTool = tool({
			inputSchema: z.object({}),
			execute: async () => ({ raw: true }),
			toModelOutput: () => ({ type: "json", value: { shown: 1 } }),
		});
		expect((await run(jsonTool, "j", {})).reply.text).toBe('{"shown":1}');
		const errorTool = tool({
			inputSchema: z.object({}),
			execute: async () => "x",
			toModelOutput: () => ({ type: "error-text", value: "bad" }),
		});
		expect((await run(errorTool, "e", {})).reply).toEqual({
			text: "bad",
			isError: true,
		});
		const plain = tool({
			inputSchema: z.object({}),
			execute: async () => ({ a: 1 }),
		});
		expect((await run(plain, "p", {})).reply.text).toBe('{"a":1}');
	});

	it("keeps image blocks and joins text-only content", async () => {
		const image = tool({
			inputSchema: z.object({}),
			execute: async () => "x",
			toModelOutput: () => ({
				type: "content",
				value: [
					{ type: "text", text: "shot" },
					{
						type: "file",
						data: { type: "data", data: "iVBOR" },
						mediaType: "image/png",
					} as never,
				],
			}),
		});
		expect((await run(image, "i", {})).reply.content).toEqual([
			{ type: "text", text: "shot" },
			{ type: "image", data: "iVBOR", mimeType: "image/png" },
		]);
		const texts = tool({
			inputSchema: z.object({}),
			execute: async () => ({ huge: "y".repeat(10_000) }),
			toModelOutput: () => ({
				type: "content",
				value: [
					{ type: "text", text: "a" },
					{ type: "text", text: "b" },
				],
			}),
		});
		expect((await run(texts, "c", {})).reply).toEqual({
			text: "a\nb",
			isError: false,
		});
	});
});
