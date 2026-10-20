import {
	type ModelMessage,
	simulateReadableStream,
	type ToolSet,
	tool,
} from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { SessionItemId } from "#/domain/ids";
import type { SessionItem } from "#/domain/session-item";
import {
	CODE_MODE_DEFERRED_TOOLS,
	deferredToolSurface,
	deferredToolsInstructions,
	loadedDeferredTools,
	loadedDeferredToolsFromItems,
	loadedDeferredToolsFromMessages,
	oneLineDescription,
	PLAN_ONLY_TOOLS,
} from "./deferred-tools";
import { runModelAgentStep } from "./model-agent-loop";

const simple = (description: string) =>
	tool({
		description,
		inputSchema: z.object({ value: z.string().optional() }),
		execute: async () => `${description} ran`,
	});

const turnTools = (): ToolSet => ({
	read: simple("Read a file"),
	bash: simple("Run a command"),
	agent: simple("Start a subagent"),
	agent_send: simple("Steer or stop a subagent"),
	enter_plan_mode: simple("Enter plan mode"),
	propose_plan: simple("Propose a plan"),
	web_search: simple("Search the web"),
	request_project_secret: simple("Ask for a secret"),
	search_mcp_tools: simple("Search the MCP tools. Returns schemas."),
	call_mcp_tool: simple("Call an MCP tool."),
});

/** What api-turn defers in code mode primary. */
const PRIMARY = [...CODE_MODE_DEFERRED_TOOLS, ...PLAN_ONLY_TOOLS];

describe("deferred tool surface", () => {
	it("keeps the workflow tools in the list, in order, and defers only MCP search/call and propose_plan", () => {
		const surface = deferredToolSurface({
			tools: turnTools(),
			deferred: PRIMARY,
			loaded: [],
			unlisted: PLAN_ONLY_TOOLS,
		});
		expect(surface.order()).toEqual([
			"read",
			"bash",
			"agent",
			"agent_send",
			"enter_plan_mode",
			"web_search",
			"request_project_secret",
		]);
		expect(Object.keys(surface.tools)).not.toContain("find_tools");
		// Executable from run_code even though not in the list.
		expect(Object.keys(surface.tools)).toContain("call_mcp_tool");
		expect(surface.deferred.map((entry) => entry.name)).toEqual([
			"call_mcp_tool",
			"search_mcp_tools",
		]);
	});

	it("adds propose_plan only while planning, appended, and keeps it once called", () => {
		let planning = false;
		const surface = deferredToolSurface({
			tools: turnTools(),
			deferred: PLAN_ONLY_TOOLS,
			loaded: [],
			forceLoaded: () => (planning ? PLAN_ONLY_TOOLS : []),
			unlisted: PLAN_ONLY_TOOLS,
		});
		const before = surface.order();
		// Byte-stable across requests until plan mode starts.
		expect(surface.order()).toEqual(before);
		expect(before).not.toContain("propose_plan");
		expect(surface.deferred).toEqual([]);
		planning = true;
		const after = surface.order();
		expect(after.slice(0, before.length)).toEqual(before);
		expect(after.slice(before.length)).toEqual(["propose_plan"]);
		planning = false;
		expect(surface.order()).toEqual(after);
	});

	it("rebuilds the added order from the chat's recorded calls, compaction-proof", () => {
		const deferred = new Set(PRIMARY);
		const items: SessionItem[] = [
			{
				kind: "dynamicToolCall",
				id: SessionItemId("a"),
				tool: "agent",
				status: "completed",
			},
			{
				kind: "dynamicToolCall",
				id: SessionItemId("b"),
				tool: "propose_plan",
				status: "completed",
			},
		];
		expect(loadedDeferredToolsFromItems(items, deferred)).toEqual([
			"propose_plan",
		]);
		const messages: ModelMessage[] = [
			{
				role: "assistant",
				content: [
					{
						type: "tool-call",
						toolCallId: "x",
						toolName: "propose_plan",
						input: {},
					},
				],
			},
		];
		expect(loadedDeferredToolsFromMessages(messages, deferred)).toEqual([
			"propose_plan",
		]);
		expect(loadedDeferredTools(items, messages, PRIMARY)).toEqual([
			"propose_plan",
		]);
	});

	it("returns the set unchanged when nothing is deferred", () => {
		const tools = { read: simple("Read") };
		const surface = deferredToolSurface({
			tools,
			deferred: PRIMARY,
			loaded: [],
		});
		expect(surface.tools).toBe(tools);
		expect(surface.order()).toEqual(["read"]);
		expect(surface.deferred).toEqual([]);
	});
});

describe("the system prompt's list of deferred tools", () => {
	it("names the run_code-only tools with one line each, sorted, whatever was added", () => {
		const surface = deferredToolSurface({
			tools: turnTools(),
			deferred: PRIMARY,
			loaded: [],
			unlisted: PLAN_ONLY_TOOLS,
		});
		const prompt = deferredToolsInstructions(surface.deferred);
		expect(prompt).toContain("call them from inside run_code");
		expect(prompt).toContain("searchTools(query)");
		expect(prompt).toContain("- search_mcp_tools: Search the MCP tools.");
		expect(prompt).not.toContain("find_tools");
		expect(prompt).not.toContain("agent");
		expect(prompt).not.toContain("propose_plan");
		const later = deferredToolSurface({
			tools: turnTools(),
			deferred: PRIMARY,
			loaded: ["propose_plan"],
			unlisted: PLAN_ONLY_TOOLS,
		});
		expect(deferredToolsInstructions(later.deferred)).toBe(prompt);
	});

	it("adds nothing, and never mentions searchTools, when nothing is listed", () => {
		const surface = deferredToolSurface({
			tools: turnTools(),
			deferred: PLAN_ONLY_TOOLS,
			loaded: [],
			unlisted: PLAN_ONLY_TOOLS,
		});
		expect(surface.deferred).toEqual([]);
		expect(deferredToolsInstructions(surface.deferred)).toBe("");
		expect(oneLineDescription("x".repeat(300))).toHaveLength(160);
	});
});

const usage = {
	inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 2, text: 2, reasoning: 0 },
};

function scriptedModel(
	calls: readonly { toolName: string; input: string }[],
): MockLanguageModelV4 {
	let index = 0;
	return new MockLanguageModelV4({
		doStream: async () => {
			const call = calls[index++];
			return {
				stream: simulateReadableStream({
					initialDelayInMs: null,
					chunkDelayInMs: null,
					chunks: (call
						? [
								{
									type: "tool-call" as const,
									toolCallId: `call-${index}`,
									toolName: call.toolName,
									input: call.input,
								},
								{
									type: "finish" as const,
									finishReason: {
										unified: "tool-calls" as const,
										raw: "tool_calls",
									},
									usage,
								},
							]
						: [
								{ type: "text-start" as const, id: "t" },
								{ type: "text-delta" as const, id: "t", delta: "Done." },
								{ type: "text-end" as const, id: "t" },
								{
									type: "finish" as const,
									finishReason: { unified: "stop" as const, raw: "stop" },
									usage,
								},
							]) as never,
				}),
			};
		},
	});
}

describe("deferred tools in the model loop", () => {
	const base = {
		userId: "owner",
		modelId: "model",
		instructions: "Work",
		toolSurface: "implementation" as const,
		signal: new AbortController().signal,
		onEvent: vi.fn(async () => {}),
		onStep: vi.fn(async () => {}),
	};

	it("sends agent from the first request and the same list on every step", async () => {
		const model = scriptedModel([
			{ toolName: "agent", input: '{"value":"x"}' },
			{ toolName: "read", input: '{"value":"y"}' },
		]);
		const agent = vi.fn(async () => "spawned");
		const tools = {
			...turnTools(),
			agent: tool({ ...simple("Start a subagent"), execute: agent }),
		};
		// Each durable step rebuilds the surface from the history, as api-turn does.
		const step = (messages: ModelMessage[]) => {
			const surface = deferredToolSurface({
				tools,
				deferred: PRIMARY,
				loaded: loadedDeferredToolsFromMessages(messages, new Set(PRIMARY)),
				forceLoaded: () => [],
				unlisted: PLAN_ONLY_TOOLS,
			});
			return runModelAgentStep(
				{ ...base, messages, tools: surface.tools, toolOrder: surface.order },
				{ model },
			);
		};
		const first = await step([{ role: "user", content: "Delegate" }]);
		const second = await step(first.messages);
		await step(second.messages);
		const sent = model.doStreamCalls.map((call) =>
			JSON.stringify(call.tools ?? []),
		);
		const names = (model.doStreamCalls[0]?.tools ?? []).map(
			(entry) => entry.name,
		);
		expect(names).toEqual([
			"read",
			"bash",
			"agent",
			"agent_send",
			"enter_plan_mode",
			"web_search",
			"request_project_secret",
		]);
		// Cache: byte-identical tool definitions on every step.
		expect(sent[1]).toBe(sent[0]);
		expect(sent[2]).toBe(sent[0]);
		expect(agent).toHaveBeenCalledOnce();
	});

	it("does not run a deferred tool the model calls while it is not offered", async () => {
		const model = scriptedModel([{ toolName: "propose_plan", input: "{}" }]);
		const propose = vi.fn(async () => "proposed");
		const tools = {
			...turnTools(),
			propose_plan: tool({ ...simple("Propose"), execute: propose }),
		};
		const surface = deferredToolSurface({
			tools,
			deferred: PLAN_ONLY_TOOLS,
			loaded: [],
		});
		await runModelAgentStep(
			{
				...base,
				messages: [{ role: "user", content: "Go" }],
				tools: surface.tools,
				toolOrder: surface.order,
			},
			{ model },
		).catch(() => {});
		expect(propose).not.toHaveBeenCalled();
	});
});
