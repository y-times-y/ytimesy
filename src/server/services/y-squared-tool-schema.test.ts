import { asSchema } from "ai";
import { describe, expect, it } from "vitest";
import { Y_SQUARED_MESSAGE_MODES, Y_SQUARED_TOOLS } from "#/domain/y-squared";
import { ySquaredToolList } from "#/server/services/claude-code-runner";
import { mcpToolDefinitions } from "#/server/services/mcp-tool-call";
import { ySquaredTools } from "#/server/services/y-squared-tools";

const tools = () =>
	ySquaredTools({ userId: "u", projectId: "p", selfId: "y2" });

type Prop = { enum?: string[]; description?: string };
const modeOf = (schema: unknown) =>
	(schema as { properties: { mode?: Prop } }).properties.mode;

describe("message_thread's mode reaches the model on every route", () => {
	it("Claude Code MCP bridge definitions (tools/list)", async () => {
		const defs = await mcpToolDefinitions(tools());
		const mode = modeOf(
			defs.find((d) => d.name === "message_thread")?.inputSchema,
		);
		expect(mode?.enum).toEqual([...Y_SQUARED_MESSAGE_MODES]);
		expect(mode?.description).toContain("steer");
	});
	it("API / Codex / Grok loop and code-mode declarations (asSchema)", async () => {
		const schema = await asSchema(tools().message_thread?.inputSchema as never)
			.jsonSchema;
		const mode = modeOf(schema);
		expect(mode?.enum).toEqual([...Y_SQUARED_MESSAGE_MODES]);
		expect(mode?.description).toContain("interrupt");
		expect((schema as { required: string[] }).required).toEqual(["id", "text"]);
	});
	it("the tool set is exactly Y_SQUARED_TOOLS minus ask_user", () => {
		expect(new Set(Object.keys(tools()))).toEqual(
			new Set([...Y_SQUARED_TOOLS].filter((n) => n !== "ask_user")),
		);
	});
	it("the Claude Code prompt names every tool of the set", () => {
		const list = ySquaredToolList(Object.keys(tools()));
		for (const name of [
			"schedule",
			"read_canvas",
			"show_canvas",
			"message_thread",
		])
			expect(list).toContain(name);
	});
});
