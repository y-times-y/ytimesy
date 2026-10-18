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
	deferredToolSurface,
	FIND_TOOLS_TOOL,
	loadedDeferredToolsFromItems,
	loadedDeferredToolsFromMessages,
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
	enter_plan_mode: simple("Enter plan mode"),
	propose_plan: simple("Propose a plan"),
	agent: simple("Start a subagent"),
	agent_send: simple("Steer or stop a subagent"),
	web_search: simple("Search the web"),
});

const GROUPS = [
	{ summary: "delegate to subagents", tools: ["agent", "agent_send"] },
	{ summary: "plan mode", tools: ["enter_plan_mode", "propose_plan"] },
];

describe("deferred tool surface", () => {
	it("offers the always-on tools in their order, then find_tools, and nothing deferred", () => {
		const surface = deferredToolSurface({
			tools: turnTools(),
			groups: GROUPS,
			loaded: [],
		});
		expect(surface.order()).toEqual([
			"read",
			"bash",
			"web_search",
			FIND_TOOLS_TOOL,
		]);
		expect(Object.keys(surface.tools)).toContain("agent");
		expect(surface.tools[FIND_TOOLS_TOOL]?.description).toContain(
			"agent, agent_send (delegate to subagents); enter_plan_mode, propose_plan (plan mode)",
		);
	});

	it("loads a whole group by name or keyword and appends it after earlier loads", async () => {
		const surface = deferredToolSurface({
			tools: turnTools(),
			groups: GROUPS,
			loaded: [],
		});
		const before = surface.order();
		const found = (await surface.tools[FIND_TOOLS_TOOL]?.execute?.(
			{ query: "plan" },
			{ toolCallId: "f1", messages: [] },
		)) as { loaded: { name: string; input_schema: unknown }[] };
		expect(found.loaded.map((entry) => entry.name)).toEqual([
			"enter_plan_mode",
			"propose_plan",
		]);
		expect(found.loaded[0]?.input_schema).toMatchObject({ type: "object" });
		await surface.tools[FIND_TOOLS_TOOL]?.execute?.(
			{ query: "agent" },
			{ toolCallId: "f2", messages: [] },
		);
		const after = surface.order();
		// Cache-stable: the earlier list is an unchanged prefix of the new one.
		expect(after.slice(0, before.length)).toEqual(before);
		expect(after.slice(before.length)).toEqual([
			"enter_plan_mode",
			"propose_plan",
			"agent",
			"agent_send",
		]);
		// Loading again changes nothing.
		await surface.tools[FIND_TOOLS_TOOL]?.execute?.(
			{ query: "plan mode" },
			{ toolCallId: "f3", messages: [] },
		);
		expect(surface.order()).toEqual(after);
	});

	it("rebuilds the load order from the chat's recorded calls, compaction-proof", () => {
		const deferred = new Set(GROUPS.flatMap((group) => group.tools));
		const items: SessionItem[] = [
			{
				kind: "dynamicToolCall",
				id: SessionItemId("a"),
				tool: FIND_TOOLS_TOOL,
				output: JSON.stringify({
					type: "json",
					value: { loaded: [{ name: "agent" }, { name: "agent_send" }] },
				}),
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
			"agent",
			"agent_send",
			"propose_plan",
		]);
		const messages: ModelMessage[] = [
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "x",
						toolName: FIND_TOOLS_TOOL,
						output: {
							type: "json",
							value: { loaded: [{ name: "enter_plan_mode" }] },
						},
					},
				],
			},
		];
		expect(loadedDeferredToolsFromMessages(messages, deferred)).toEqual([
			"enter_plan_mode",
		]);
	});

	it("returns the set unchanged when nothing is deferred", () => {
		const tools = { read: simple("Read") };
		const surface = deferredToolSurface({ tools, groups: GROUPS, loaded: [] });
		expect(surface.tools).toBe(tools);
		expect(surface.order()).toEqual(["read"]);
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
					chunks: call
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
							],
				}),
			};
		},
	});
}

describe("deferred tools in the model loop", () => {
	it("sends a loaded tool from the next request on, appended without reordering earlier tools", async () => {
		const model = scriptedModel([
			{ toolName: FIND_TOOLS_TOOL, input: '{"query":"agent"}' },
			{ toolName: "agent", input: '{"value":"x"}' },
		]);
		const agent = vi.fn(async () => "spawned");
		const tools = {
			...turnTools(),
			agent: tool({ ...simple("Start a subagent"), execute: agent }),
		};
		const base = {
			userId: "owner",
			modelId: "model",
			instructions: "Work",
			toolSurface: "implementation" as const,
			signal: new AbortController().signal,
			onEvent: vi.fn(async () => {}),
			onStep: vi.fn(async () => {}),
		};
		// Each durable step rebuilds the surface from the history, as api-turn does.
		const step = (messages: ModelMessage[]) => {
			const surface = deferredToolSurface({
				tools,
				groups: GROUPS,
				loaded: loadedDeferredToolsFromMessages(
					messages,
					new Set(GROUPS.flatMap((group) => group.tools)),
				),
			});
			return runModelAgentStep(
				{ ...base, messages, tools: surface.tools, toolOrder: surface.order },
				{ model },
			);
		};
		const first = await step([{ role: "user", content: "Delegate" }]);
		const second = await step(first.messages);
		const third = await step(second.messages);
		const sent = model.doStreamCalls.map((call) =>
			(call.tools ?? []).map((entry) => entry.name),
		);
		expect(sent[0]).toEqual(["read", "bash", "web_search", FIND_TOOLS_TOOL]);
		expect(sent[1]).toEqual([...sent[0], "agent", "agent_send"]);
		expect(sent[2]).toEqual(sent[1]);
		expect(agent).toHaveBeenCalledOnce();
		expect(JSON.stringify(third.messages)).toContain("spawned");
	});

	it("does not run a deferred tool the model calls before loading it", async () => {
		const model = scriptedModel([{ toolName: "agent", input: "{}" }]);
		const agent = vi.fn(async () => "spawned");
		const tools = {
			...turnTools(),
			agent: tool({ ...simple("Start"), execute: agent }),
		};
		const surface = deferredToolSurface({ tools, groups: GROUPS, loaded: [] });
		await runModelAgentStep(
			{
				userId: "owner",
				modelId: "model",
				instructions: "Work",
				toolSurface: "implementation",
				messages: [{ role: "user", content: "Go" }],
				tools: surface.tools,
				toolOrder: surface.order,
				signal: new AbortController().signal,
				onEvent: vi.fn(async () => {}),
				onStep: vi.fn(async () => {}),
			},
			{ model },
		).catch(() => {});
		expect(agent).not.toHaveBeenCalled();
	});
});
