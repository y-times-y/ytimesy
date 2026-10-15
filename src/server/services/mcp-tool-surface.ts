import {
	type JSONSchema7,
	type JSONValue,
	jsonSchema,
	type ToolSet,
	tool,
} from "ai";
import {
	CALL_MCP_TOOL_TOOL,
	SEARCH_MCP_TOOLS_TOOL,
} from "#/domain/mcp-tool-call";
import { estimateContextTokens } from "./api-agent-context";
import type { McpCatalogEntry } from "./mcp-tools";

/** MCP setups this small keep their real tools inline; larger ones are searched. */
export const INLINE_MCP_TOKEN_LIMIT = 2_000;
type JSONSchema7Definition = JSONSchema7 | boolean;

const SERVER_LINE_CHARACTERS = 400;
const PURPOSE_CHARACTERS = 160;
const SEARCH_RESULTS = 8;
/** Full descriptions and schemas returned by one search, best matches first. */
const SEARCH_DETAIL_CHARACTERS = 24_000;
const SHORT_DESCRIPTION_CHARACTERS = 200;

const clip = (text: string, limit: number) =>
	text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;

/** Estimated tokens of the MCP tool definitions if they were offered inline. */
export function inlineMcpTokens(catalog: readonly McpCatalogEntry[]) {
	return estimateContextTokens(
		catalog.map((entry) => ({
			name: entry.name,
			description: `[MCP ${entry.server}] ${entry.description}`,
			schema: entry.inputSchema,
		})),
	);
}

/** One bounded line per server: name, purpose and tool names. */
export function mcpServerCatalog(
	catalog: readonly McpCatalogEntry[],
	purposes: Readonly<Record<string, string>> = {},
) {
	const servers = [...new Set(catalog.map((entry) => entry.server))];
	return servers
		.map((server) => {
			const tools = catalog
				.filter((entry) => entry.server === server)
				.map((entry) => entry.tool);
			const purpose = purposes[server]?.split(/(?<=[.!?])\s|\n/)[0]?.trim();
			return clip(
				`- ${server}${purpose ? ` (${clip(purpose, PURPOSE_CHARACTERS)})` : ""}: ${tools.length} tools: ${tools.join(", ")}`,
				SERVER_LINE_CHARACTERS,
			);
		})
		.join("\n");
}

const words = (text: string) =>
	text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length > 1);

/** Ranks tools by query words in the name (weighted) and description. */
export function searchMcpCatalog(
	catalog: readonly McpCatalogEntry[],
	query: string,
	server?: string,
) {
	const terms = words(query);
	const exact = query.trim().toLowerCase();
	return catalog
		.filter((entry) => !server || entry.server === server)
		.map((entry, order) => {
			const name = entry.tool.toLowerCase();
			const nameWords = new Set(words(entry.tool));
			const description = entry.description.toLowerCase();
			let score = name === exact || entry.name === query.trim() ? 100 : 0;
			for (const term of terms) {
				if (nameWords.has(term)) score += 4;
				else if (name.includes(term)) score += 3;
				if (description.includes(term)) score += 1;
			}
			return { entry, score, order };
		})
		.filter(({ score }) => score > 0 || terms.length === 0)
		.sort((a, b) => b.score - a.score || a.order - b.order)
		.slice(0, SEARCH_RESULTS)
		.map(({ entry }) => entry);
}

type SchemaIssue = string;

const typeOf = (value: unknown) =>
	value === null
		? "null"
		: Array.isArray(value)
			? "array"
			: Number.isInteger(value)
				? "integer"
				: typeof value;

const matchesType = (value: unknown, type: string) => {
	const actual = typeOf(value);
	return (
		actual === type ||
		(type === "number" && actual === "integer") ||
		(type === "integer" && actual === "integer")
	);
};

/**
 * Checks the common JSON Schema keywords MCP servers declare. It is a fast
 * first check so the model can correct itself; the server stays the authority.
 * Code-generating validators (ajv) cannot run on Workers.
 */
export function mcpSchemaIssues(
	schema: JSONSchema7Definition,
	value: unknown,
	path = "arguments",
	depth = 0,
): SchemaIssue[] {
	if (typeof schema === "boolean")
		return schema ? [] : [`${path}: not allowed`];
	if (depth > 12) return [];
	const issues: SchemaIssue[] = [];
	const types =
		schema.type === undefined
			? []
			: Array.isArray(schema.type)
				? schema.type
				: [schema.type];
	if (types.length && !types.some((type) => matchesType(value, type)))
		return [`${path}: expected ${types.join(" or ")}, got ${typeOf(value)}`];
	if (
		schema.enum &&
		!schema.enum.some(
			(option) => JSON.stringify(option) === JSON.stringify(value),
		)
	)
		issues.push(
			`${path}: must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(", ")}`,
		);
	if (
		schema.const !== undefined &&
		JSON.stringify(schema.const) !== JSON.stringify(value)
	)
		issues.push(`${path}: must be ${JSON.stringify(schema.const)}`);
	const branches = schema.anyOf ?? schema.oneOf;
	if (
		branches &&
		!branches.some(
			(branch) => mcpSchemaIssues(branch, value, path, depth + 1).length === 0,
		)
	)
		issues.push(`${path}: matches none of the allowed shapes`);
	for (const branch of schema.allOf ?? [])
		issues.push(...mcpSchemaIssues(branch, value, path, depth + 1));
	if (typeOf(value) === "object") {
		const record = value as Record<string, unknown>;
		const properties = schema.properties ?? {};
		for (const key of schema.required ?? [])
			if (!(key in record)) issues.push(`${path}.${key}: required`);
		for (const [key, item] of Object.entries(record)) {
			if (key in properties)
				issues.push(
					...mcpSchemaIssues(
						properties[key],
						item,
						`${path}.${key}`,
						depth + 1,
					),
				);
			else if (schema.additionalProperties === false)
				issues.push(`${path}.${key}: unknown property`);
			else if (typeof schema.additionalProperties === "object")
				issues.push(
					...mcpSchemaIssues(
						schema.additionalProperties,
						item,
						`${path}.${key}`,
						depth + 1,
					),
				);
		}
	}
	if (Array.isArray(value) && schema.items && !Array.isArray(schema.items)) {
		const items = schema.items;
		value.forEach((item, index) => {
			issues.push(
				...mcpSchemaIssues(items, item, `${path}[${index}]`, depth + 1),
			);
		});
	}
	return issues.slice(0, 20);
}

function searchResult(matches: readonly McpCatalogEntry[]) {
	let budget = SEARCH_DETAIL_CHARACTERS;
	return matches.map((entry) => {
		const detail = {
			server: entry.server,
			tool: entry.tool,
			description: entry.description,
			inputSchema: entry.inputSchema,
		};
		const size = JSON.stringify(detail).length;
		if (size <= budget) {
			budget -= size;
			return detail;
		}
		return {
			server: entry.server,
			tool: entry.tool,
			description: clip(entry.description, SHORT_DESCRIPTION_CHARACTERS),
			inputSchema: "omitted for size; search for this exact tool name",
		};
	});
}

const isMcpError = (output: unknown) =>
	!!output &&
	typeof output === "object" &&
	(output as { isError?: unknown }).isError === true;

/**
 * Offers the turn's MCP tools. Small setups keep their real tools inline.
 * Larger ones get a fixed pair, search_mcp_tools and call_mcp_tool, so no
 * per-tool schema is sent and the tool list never changes mid-turn (adding
 * discovered tools would change the cached tools prefix). A call runs the
 * real tool from `tools`, already wrapped with hooks, plan mode and
 * redaction, under its own MCP name.
 */
export function mcpToolSurface(input: {
	tools: ToolSet;
	catalog: readonly McpCatalogEntry[];
	purposes?: Readonly<Record<string, string>>;
	inlineTokenLimit?: number;
}): ToolSet {
	const { tools, catalog } = input;
	if (
		!catalog.length ||
		inlineMcpTokens(catalog) <=
			(input.inlineTokenLimit ?? INLINE_MCP_TOKEN_LIMIT)
	)
		return tools;
	const deferred = new Set(catalog.map((entry) => entry.name));
	const servers = [...new Set(catalog.map((entry) => entry.server))];
	const listing = mcpServerCatalog(catalog, input.purposes);
	const resolve = (server: string, name: string) =>
		catalog.find(
			(entry) =>
				entry.server === server && (entry.tool === name || entry.name === name),
		);
	return {
		...Object.fromEntries(
			Object.entries(tools).filter(([name]) => !deferred.has(name)),
		),
		[SEARCH_MCP_TOOLS_TOOL]: tool({
			description: `Find tools on the user's connected MCP servers and get their descriptions and input schemas before calling them with ${CALL_MCP_TOOL_TOOL}. Connected servers:\n${listing}`,
			inputSchema: jsonSchema<{ query: string; server?: string }>({
				type: "object",
				properties: {
					query: {
						type: "string",
						description:
							"Words describing the action, or an exact tool name for its full schema.",
					},
					server: { type: "string", enum: servers },
				},
				required: ["query"],
				additionalProperties: false,
			}),
			execute: async ({ query, server }) => {
				const matches = searchMcpCatalog(catalog, query, server);
				return matches.length
					? { tools: searchResult(matches) }
					: {
							tools: [],
							hint: "No match. Try other words; the connected servers and their tools are listed in this tool's description.",
						};
			},
		}),
		[CALL_MCP_TOOL_TOOL]: tool({
			description: `Call a tool on a connected MCP server (listed in ${SEARCH_MCP_TOOLS_TOOL}). Get the tool's input schema with ${SEARCH_MCP_TOOLS_TOOL} first unless you already have it; arguments are validated against it.`,
			inputSchema: jsonSchema<{
				server: string;
				tool: string;
				arguments?: Record<string, unknown>;
			}>({
				type: "object",
				properties: {
					server: { type: "string", enum: servers },
					tool: { type: "string", description: "The tool's exact name." },
					arguments: {
						type: "object",
						description: "The tool's arguments, matching its input schema.",
					},
				},
				required: ["server", "tool"],
				additionalProperties: false,
			}),
			execute: async (
				{ server, tool: name, arguments: args = {} },
				options,
			) => {
				const entry = resolve(server, name);
				const target = entry && tools[entry.name];
				if (!entry || !target?.execute)
					return {
						isError: true,
						error: `Unknown MCP tool "${name}" on server "${server}".`,
						tools: catalog
							.filter((candidate) => candidate.server === server)
							.map((candidate) => candidate.tool),
					};
				const issues = mcpSchemaIssues(entry.inputSchema, args);
				if (issues.length)
					return {
						isError: true,
						error: `Arguments do not match ${entry.tool}'s input schema; fix them and call again.`,
						issues,
						inputSchema: entry.inputSchema,
					};
				const output = await target.execute(args as never, options);
				// A server-side rejection also returns the schema to correct against.
				return isMcpError(output) && !("inputSchema" in (output as object))
					? { ...(output as object), inputSchema: entry.inputSchema }
					: output;
			},
			toModelOutput: (options) => {
				const call = options.input as { server?: string; tool?: string };
				const entry =
					call?.server && call.tool ? resolve(call.server, call.tool) : null;
				const target = entry ? tools[entry.name] : undefined;
				const output = options.output as Record<string, unknown> | null;
				// Schema hints ride along as JSON; content results convert as the real tool does.
				if (output && typeof output === "object" && "inputSchema" in output)
					return { type: "json", value: output as JSONValue };
				return target?.toModelOutput
					? target.toModelOutput({ ...options, input: options.input as never })
					: { type: "json", value: (options.output ?? null) as JSONValue };
			},
		}),
	};
}
