import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionItemId } from "#/domain/ids";
import type { DynamicToolCallItem } from "#/domain/session-item";
import { brandMark } from "./brand-logo";
import { McpServerIcon } from "./mcp-server-icon";
import { ToolDetailBody } from "./tool-detail-body";

const call = (
	tool: string,
	input: object,
	output?: object,
	status: DynamicToolCallItem["status"] = "completed",
): DynamicToolCallItem => ({
	kind: "dynamicToolCall",
	id: SessionItemId("t"),
	tool,
	input: JSON.stringify(input),
	output: output ? JSON.stringify(output) : undefined,
	status,
});

describe("MCP server icons", () => {
	it("uses the bundled Settings mark, by name or by URL host", () => {
		expect(brandMark("notion-notion", "Notion")).toMatchObject({
			kind: "logo",
			brand: "notion",
		});
		expect(
			brandMark("docs", "docs", "https://mcp.linear.app/sse"),
		).toMatchObject({ kind: "logo", brand: "linear" });
		expect(brandMark("slack", "Slack")).toMatchObject({
			kind: "letter",
			label: "S",
			background: "#4A154B",
		});
	});

	it("falls back to the server's initial, and never a globe", () => {
		expect(brandMark("acme-tools", "acme-tools", "not a url")).toEqual({
			kind: "letter",
			brand: undefined,
			label: "A",
			background: undefined,
		});
		const html = renderToStaticMarkup(<McpServerIcon server="acme" />);
		expect(html).toContain('data-letter="true"');
		expect(html).toContain(">A<");
		expect(renderToStaticMarkup(<McpServerIcon />)).toContain("lucide-plug");
	});
});

describe("an opened MCP card", () => {
	it("shows arguments as labelled fields and JSON text as fields", () => {
		const html = renderToStaticMarkup(
			<ToolDetailBody
				item={call(
					"mcp__notion-notion__notion-fetch",
					{
						id: "https://app.notion.com/p/1",
						page_size: 5,
						filters: { archived: false },
					},
					{
						content: [
							{
								type: "text",
								text: JSON.stringify({ title: "Lessons", tags: ["a", "b"] }),
							},
						],
						isError: false,
					},
				)}
			/>,
		);
		expect(html).toContain("notion-notion / </span>notion-fetch");
		expect(html).toContain(">Input<");
		expect(html).toContain("<dt>page size</dt>");
		expect(html).toContain('href="https://app.notion.com/p/1"');
		expect(html).toContain('data-type="boolean"');
		expect(html).toContain(">Output<");
		expect(html).toContain("<dt>title</dt>");
		expect(html).toContain("Lessons");
		expect(html).not.toContain("&quot;title&quot;");
		expect(html).not.toContain("tool-panel-tag");
	});

	it("marks an isError result and shows images inline", () => {
		const error = renderToStaticMarkup(
			<ToolDetailBody
				item={call(
					"mcp__linear__get_issue",
					{},
					{
						content: [{ type: "text", text: "Issue not found" }],
						isError: true,
					},
				)}
			/>,
		);
		expect(error).toContain('data-tone="bad">Error</span>');
		expect(error).toContain("No arguments");
		expect(error).toContain("Issue not found");
		const image = renderToStaticMarkup(
			<ToolDetailBody
				item={call(
					"mcp__figma__get_image",
					{ node: "1:2" },
					{ content: [{ type: "image", mimeType: "image/png", data: "iVBO" }] },
				)}
			/>,
		);
		expect(image).toContain('src="data:image/png;base64,iVBO"');
	});

	it("clamps long output behind Show more", () => {
		const html = renderToStaticMarkup(
			<ToolDetailBody
				item={call(
					"mcp__notion__fetch",
					{ id: "x" },
					{ content: [{ type: "text", text: "line\n".repeat(80) }] },
				)}
			/>,
		);
		expect(html).toContain('class="tool-clamp"');
		expect(html).toContain("Show more");
	});
});
