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
			"list_models",
			"set_thread_model",
		])
			expect(list).toContain(name);
		// With no names given the prompt lists the whole set.
		expect(ySquaredToolList()).toContain("set_thread_model");
	});
});

type Field = { type?: string; description?: string };
type Shape = { properties: Record<string, Field>; required?: string[] };

/**
 * The model parameters are optional, and optional parameters are the ones a
 * route's schema conversion can silently drop: they must be in what the model
 * actually sees on every route (the Claude Code MCP bridge's tools/list, and
 * the API / Codex / Grok loop's asSchema declarations).
 */
describe("the model parameters reach the model on every route", () => {
	const seen = async (name: string): Promise<Shape[]> => {
		const defs = await mcpToolDefinitions(tools());
		const bridge = defs.find((d) => d.name === name)?.inputSchema as Shape;
		const direct = (await asSchema(tools()[name]?.inputSchema as never)
			.jsonSchema) as Shape;
		return [bridge, direct];
	};
	it("start_thread: model, reasoning and speed, all optional", async () => {
		for (const schema of await seen("start_thread")) {
			expect(Object.keys(schema.properties)).toEqual(
				expect.arrayContaining(["model", "reasoning", "speed"]),
			);
			expect(schema.properties.model?.description).toContain("list_models");
			expect(schema.required).toEqual(["title", "brief"]);
		}
	});
	it("set_thread_model: id and model required; reasoning, speed, interrupt optional", async () => {
		for (const schema of await seen("set_thread_model")) {
			expect(Object.keys(schema.properties).sort()).toEqual([
				"id",
				"interrupt",
				"model",
				"reasoning",
				"speed",
			]);
			expect(schema.required).toEqual(["id", "model"]);
			expect(schema.properties.interrupt?.type).toBe("boolean");
		}
	});
	it("list_models takes nothing", async () => {
		for (const schema of await seen("list_models"))
			expect(Object.keys(schema.properties ?? {})).toEqual([]);
	});
});
