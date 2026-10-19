import { asSchema, type ModelMessage, type ToolSet, tool } from "ai";
import { z } from "zod";
import { ENTER_PLAN_MODE_TOOL, PROPOSE_PLAN_TOOL } from "#/domain/agent-plan";
import {
	CALL_MCP_TOOL_TOOL,
	SEARCH_MCP_TOOLS_TOOL,
} from "#/domain/mcp-tool-call";
import { REQUEST_PROJECT_SECRET_TOOL } from "#/domain/secret-request";
import type { SessionItem } from "#/domain/session-item";
import { AGENT_SEND_TOOL, AGENT_TOOL } from "#/domain/subagent";

/**
 * Deferred tools (docs/subagents.md, "Deferred tools"): rarely used tools are
 * not in the request's tool list until the model loads them with
 * find_tools. The always-on list stays byte-stable for the provider prompt
 * cache:
 *
 * - The always-on tools keep their order and find_tools sits right after
 *   them; neither ever changes within a chat.
 * - A loaded tool is appended after everything loaded before it, in load
 *   order, and stays for the rest of the chat. Nothing earlier is reordered
 *   or removed, so every later request repeats the same list.
 * - The load order is rebuilt from the chat's own tool calls (find_tools
 *   results and direct calls), which survive compaction and new turns, so a
 *   reloaded turn sends the same list.
 *
 * Loading one tool still changes the tools block once (the provider
 * re-caches the prefix after it); grouping related tools (agent with
 * agent_send) makes that one load instead of two.
 */
export const FIND_TOOLS_TOOL = "find_tools";

export type DeferredToolGroup = {
	/** What the group is for, shown in find_tools' description. */
	readonly summary: string;
	readonly tools: readonly string[];
};

/** Loaded deferred tools in load order, from the chat's recorded tool calls. */
export function loadedDeferredToolsFromItems(
	items: readonly SessionItem[],
	deferred: ReadonlySet<string>,
): string[] {
	const loaded: string[] = [];
	const add = (name: unknown) => {
		if (
			typeof name === "string" &&
			deferred.has(name) &&
			!loaded.includes(name)
		)
			loaded.push(name);
	};
	for (const item of items) {
		if (item.kind !== "dynamicToolCall") continue;
		if (item.tool !== FIND_TOOLS_TOOL) {
			add(item.tool);
			continue;
		}
		for (const name of findToolsOutputNames(item.output)) add(name);
	}
	return loaded;
}

/** The same, from model messages (the current turn's calls before they reach the items). */
export function loadedDeferredToolsFromMessages(
	messages: readonly ModelMessage[],
	deferred: ReadonlySet<string>,
): string[] {
	const loaded: string[] = [];
	const add = (name: unknown) => {
		if (
			typeof name === "string" &&
			deferred.has(name) &&
			!loaded.includes(name)
		)
			loaded.push(name);
	};
	for (const message of messages) {
		if (typeof message.content === "string") continue;
		for (const part of message.content) {
			if (part.type === "tool-call" && part.toolName !== FIND_TOOLS_TOOL)
				add(part.toolName);
			if (part.type === "tool-result" && part.toolName === FIND_TOOLS_TOOL)
				for (const name of findToolsOutputNames(part.output)) add(name);
		}
	}
	return loaded;
}

function findToolsOutputNames(output: unknown): string[] {
	let value = output;
	if (typeof value === "string")
		try {
			value = JSON.parse(value);
		} catch {
			return [];
		}
	if (
		value &&
		typeof value === "object" &&
		"type" in value &&
		(value as { type: unknown }).type === "json"
	)
		value = (value as unknown as { value: unknown }).value;
	const loaded = (value as { loaded?: unknown } | null)?.loaded;
	return Array.isArray(loaded)
		? loaded.flatMap((entry) =>
				entry && typeof entry === "object" && typeof entry.name === "string"
					? [entry.name as string]
					: [],
			)
		: [];
}

function terms(text: string) {
	return (
		text
			.replace(/([a-z\d])([A-Z])/g, "$1 $2")
			.toLowerCase()
			.match(/[\p{L}\p{N}]+/gu) ?? []
	);
}

export type DeferredToolSurface = {
	/** Every tool, deferred ones included, plus find_tools: what the loop may execute once loaded. */
	readonly tools: ToolSet;
	/** The tools the next request offers, in order: always-on, find_tools, then loaded tools in load order. */
	readonly order: () => readonly string[];
	/**
	 * Every deferred tool's name and one-line description, sorted by name:
	 * the system prompt lists them so the model knows they exist. It depends
	 * only on the turn's tools, never on what is loaded, so it stays
	 * byte-stable across steps and turns.
	 */
	readonly deferred: readonly DeferredToolEntry[];
};

export type DeferredToolEntry = {
	readonly name: string;
	readonly description: string;
};

/** A tool description's first sentence, for the system prompt's list. */
export function oneLineDescription(description: string | undefined) {
	const text = (description ?? "").replace(/\s+/g, " ").trim();
	const sentence = /^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
	return sentence.length > 160 ? `${sentence.slice(0, 157)}...` : sentence;
}

/** The system prompt's list of deferred tools and how to load them. */
export function deferredToolsInstructions(
	entries: readonly DeferredToolEntry[],
	options: { readonly codeMode?: boolean | "primary" } = {},
) {
	if (!entries.length) return "";
	if (options.codeMode === "primary")
		return [
			"More tools are not in your tool list; call them from inside run_code as tools.<name>(args). In a program, searchTools(query) returns their TypeScript declarations (arguments and what they do):",
			...entries.map((entry) => `- ${entry.name}: ${entry.description}`),
		].join("\n");
	return [
		`More tools are available on demand; they are not in your tool list until you load one with ${FIND_TOOLS_TOOL} (its full schema is then added and stays for this chat)${options.codeMode ? ", or call one directly from run_code" : ""}:`,
		...entries.map((entry) => `- ${entry.name}: ${entry.description}`),
	].join("\n");
}

/**
 * Splits a turn's final tool set into always-on and deferred tools and adds
 * find_tools. With nothing to defer the set is returned unchanged.
 */
export function deferredToolSurface(input: {
	readonly tools: ToolSet;
	readonly groups: readonly DeferredToolGroup[];
	/** Loaded earlier in this chat, in load order. */
	readonly loaded: readonly string[];
	/**
	 * Offered regardless (e.g. plan tools while plan mode is active), appended
	 * like a load: a list at setup, or a function read on every request (the
	 * plan lock can turn on mid-turn from inside run_code).
	 */
	readonly forceLoaded?: readonly string[] | (() => readonly string[]);
	/**
	 * How the model reaches a deferred tool: find_tools loads it into the
	 * tool list (the default); run_code (code mode primary) calls it from a
	 * program, so no find_tools is offered and only direct calls (or forced
	 * tools) add a tool to the list.
	 */
	readonly discovery?: "find_tools" | "run_code";
	/** Deferred tools left out of the prompt's list (offered only when forced, e.g. propose_plan). */
	readonly unlisted?: readonly string[];
}): DeferredToolSurface {
	const groups = input.groups
		.map((group) => ({
			...group,
			tools: group.tools.filter((name) => name in input.tools),
		}))
		.filter((group) => group.tools.length);
	const deferred = new Set(groups.flatMap((group) => group.tools));
	const allNames = Object.keys(input.tools);
	if (!deferred.size)
		return { tools: input.tools, order: () => allNames, deferred: [] };
	const unlisted = new Set(input.unlisted ?? []);
	const entries = [...deferred]
		.filter((name) => !unlisted.has(name))
		.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
		.map((name) => ({
			name,
			description: oneLineDescription(
				typeof input.tools[name]?.description === "string"
					? input.tools[name]?.description
					: undefined,
			),
		}));
	const alwaysOn = allNames.filter((name) => !deferred.has(name));
	const loaded: string[] = [];
	const load = (name: string) => {
		if (deferred.has(name) && !loaded.includes(name)) loaded.push(name);
	};
	const forced = input.forceLoaded;
	for (const name of [
		...input.loaded,
		...(typeof forced === "function" ? [] : (forced ?? [])),
	])
		load(name);
	if (input.discovery === "run_code")
		return {
			tools: input.tools,
			order: () => {
				if (typeof forced === "function")
					for (const name of forced()) load(name);
				return [...alwaysOn, ...loaded];
			},
			deferred: entries,
		};
	const loadGroup = (name: string) => {
		for (const group of groups)
			if (group.tools.includes(name))
				for (const member of group.tools) load(member);
	};
	const describe = async (name: string) => {
		const definition = input.tools[name];
		return {
			name,
			description: definition?.description ?? "",
			input_schema: definition
				? await asSchema(definition.inputSchema).jsonSchema
				: {},
		};
	};
	const catalog = groups
		.map((group) => `${group.tools.join(", ")} (${group.summary})`)
		.join("; ");
	const findTools = tool({
		description: `Loads tools that are not offered by default; they can be called from your next step on and stay loaded for this chat. Not loaded yet: ${catalog}. Pass a tool name or a few keywords.`,
		inputSchema: z.object({
			query: z
				.string()
				.min(1)
				.max(200)
				.describe("A tool name or keywords, e.g. agent or plan"),
		}),
		execute: async ({ query }) => {
			const wanted = new Set(terms(query));
			const exact = groups.flatMap((group) =>
				group.tools.filter((name) => query.trim() === name),
			);
			const matched = exact.length
				? exact
				: groups
						.filter((group) =>
							[...group.tools, group.summary].some((text) =>
								terms(text).some((term) => wanted.has(term)),
							),
						)
						.map((group) => group.tools[0]);
			for (const name of matched) loadGroup(name);
			const names = groups
				.flatMap((group) => group.tools)
				.filter((name) =>
					matched.some((match) => sameGroup(groups, match, name)),
				);
			return {
				loaded: await Promise.all(names.map(describe)),
				...(names.length
					? { note: "Loaded. Call them from your next step." }
					: { note: `No tool matched. Not loaded yet: ${catalog}.` }),
			};
		},
	});
	return {
		tools: { ...input.tools, [FIND_TOOLS_TOOL]: findTools },
		order: () => {
			if (typeof forced === "function") for (const name of forced()) load(name);
			return [...alwaysOn, FIND_TOOLS_TOOL, ...loaded];
		},
		deferred: entries,
	};
}

function sameGroup(
	groups: readonly DeferredToolGroup[],
	left: string,
	right: string,
) {
	return groups.some(
		(group) => group.tools.includes(left) && group.tools.includes(right),
	);
}

/** The builder's deferred tools (subagents=on): rarely used, loaded on demand. */
export const BUILDER_DEFERRED_TOOL_GROUPS: readonly DeferredToolGroup[] = [
	{
		summary:
			"delegate to subagents: a writer on a fork of your VM, or a read-only researcher, reviewer or checker; steer or stop them",
		tools: [AGENT_TOOL, AGENT_SEND_TOOL],
	},
	{
		summary:
			"plan mode: get the user's approval of a plan before large, ambiguous or risky changes",
		tools: [ENTER_PLAN_MODE_TOOL, PROPOSE_PLAN_TOOL],
	},
	{
		summary:
			"ask the user for a missing credential or configuration value (API key, database URL)",
		tools: [REQUEST_PROJECT_SECRET_TOOL],
	},
];

/**
 * The deferred tools in code mode primary: callable only from run_code
 * (searchTools there returns their declarations), never through find_tools.
 * The turn-ending tools stay direct, since an inner call cannot end the
 * turn: request_project_secret is not deferred, and propose_plan is offered
 * directly once plan mode is on (forced, unlisted). MCP's search and call
 * tools exist only when a large MCP setup is deferred (mcp-tool-surface.ts).
 */
export const CODE_MODE_DEFERRED_TOOL_GROUPS: readonly DeferredToolGroup[] = [
	BUILDER_DEFERRED_TOOL_GROUPS[0] as DeferredToolGroup,
	BUILDER_DEFERRED_TOOL_GROUPS[1] as DeferredToolGroup,
	{
		summary: "the user's connected MCP servers' tools",
		tools: [SEARCH_MCP_TOOLS_TOOL, CALL_MCP_TOOL_TOOL],
	},
];

/** Deferred in code mode primary but never callable from a program (they end the turn). */
export const CODE_MODE_DIRECT_ONLY_TOOLS: readonly string[] = [
	PROPOSE_PLAN_TOOL,
];

/**
 * The deferred tools a chat has loaded, in load order: its recorded calls
 * (every earlier turn, compaction included), then this turn's model
 * messages not yet in the items.
 */
export function loadedDeferredTools(
	items: readonly SessionItem[],
	messages: readonly ModelMessage[],
	groups: readonly DeferredToolGroup[],
) {
	const deferred = new Set(groups.flatMap((group) => group.tools));
	const loaded = loadedDeferredToolsFromItems(items, deferred);
	for (const name of loadedDeferredToolsFromMessages(messages, deferred))
		if (!loaded.includes(name)) loaded.push(name);
	return loaded;
}
