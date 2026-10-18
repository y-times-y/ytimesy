import { asSchema, type ModelMessage, type ToolSet, tool } from "ai";
import { z } from "zod";
import type { SessionItem } from "#/domain/session-item";

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
		value = (value as { value: unknown }).value;
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
};

/**
 * Splits a turn's final tool set into always-on and deferred tools and adds
 * find_tools. With nothing to defer the set is returned unchanged.
 */
export function deferredToolSurface(input: {
	readonly tools: ToolSet;
	readonly groups: readonly DeferredToolGroup[];
	/** Loaded earlier in this chat, in load order. */
	readonly loaded: readonly string[];
	/** Offered regardless (e.g. plan tools while plan mode is active), appended like a load. */
	readonly forceLoaded?: readonly string[];
}): DeferredToolSurface {
	const groups = input.groups
		.map((group) => ({
			...group,
			tools: group.tools.filter((name) => name in input.tools),
		}))
		.filter((group) => group.tools.length);
	const deferred = new Set(groups.flatMap((group) => group.tools));
	const allNames = Object.keys(input.tools);
	if (!deferred.size) return { tools: input.tools, order: () => allNames };
	const alwaysOn = allNames.filter((name) => !deferred.has(name));
	const loaded: string[] = [];
	const load = (name: string) => {
		if (deferred.has(name) && !loaded.includes(name)) loaded.push(name);
	};
	for (const name of [...input.loaded, ...(input.forceLoaded ?? [])])
		load(name);
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
		order: () => [...alwaysOn, FIND_TOOLS_TOOL, ...loaded],
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
