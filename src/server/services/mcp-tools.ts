import {
	createMCPClient,
	type MCPClient,
	type OAuthClientProvider,
} from "@ai-sdk/mcp";
import { asSchema, type JSONSchema7, type ToolSet } from "ai";
import { mcpToolName } from "#/domain/mcp-tool-call";
import { redirectRefusingFetch } from "../adapters/workers-fetch";

type ConnectableMcpServer = {
	name: string;
	url: string;
	headers: Record<string, string>;
	/** OAuth servers: stored tokens, refreshed by the SDK. */
	authProvider?: OAuthClientProvider;
};

const CALL_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_CHARACTERS = 32_000;

/** One connected MCP tool: its offered name and what the server declared. */
export type McpCatalogEntry = {
	/** The prefixed tool name in the turn's tool set. */
	name: string;
	server: string;
	tool: string;
	description: string;
	inputSchema: JSONSchema7;
};

function bounded(result: unknown) {
	const text = JSON.stringify(result);
	return text.length <= MAX_OUTPUT_CHARACTERS
		? result
		: {
				truncated: true,
				originalCharacters: text.length,
				preview: text.slice(0, MAX_OUTPUT_CHARACTERS),
			};
}

/**
 * Connects the user's remote MCP servers from our server for one turn. Their
 * credentials stay here; the workspace VM never sees them. A server that fails
 * to connect is skipped and reported, so it cannot block the run.
 */
export async function connectMcpTools(
	servers: readonly ConnectableMcpServer[],
	options: { fetch?: typeof globalThis.fetch; signal?: AbortSignal } = {},
) {
	const clients: MCPClient[] = [];
	const tools: ToolSet = {};
	const catalog: McpCatalogEntry[] = [];
	/** Each server's own initialize instructions, when it gave any. */
	const purposes: Record<string, string> = {};
	const unavailable: string[] = [];
	for (const server of servers) {
		try {
			const client = await createMCPClient({
				transport: {
					type: "http",
					url: server.url,
					headers: server.headers,
					...(server.authProvider ? { authProvider: server.authProvider } : {}),
					fetch: redirectRefusingFetch(options.fetch),
				},
				initializationOptions: {
					signal: AbortSignal.any([
						AbortSignal.timeout(CONNECT_TIMEOUT_MS),
						...(options.signal ? [options.signal] : []),
					]),
				},
			});
			clients.push(client);
			if (client.instructions?.trim())
				purposes[server.name] = client.instructions.trim();
			for (const [name, definition] of Object.entries(await client.tools())) {
				const execute = definition.execute;
				catalog.push({
					name: mcpToolName(server.name, name),
					server: server.name,
					tool: name,
					description:
						typeof definition.description === "string"
							? definition.description
							: "",
					inputSchema: await asSchema(definition.inputSchema).jsonSchema,
				});
				tools[mcpToolName(server.name, name)] = {
					...definition,
					description: `[MCP ${server.name}] ${definition.description ?? name}`,
					...(execute
						? {
								execute: async (
									input: unknown,
									callOptions: Parameters<typeof execute>[1],
								) =>
									bounded(
										await execute(input as never, {
											...callOptions,
											abortSignal: AbortSignal.any([
												AbortSignal.timeout(CALL_TIMEOUT_MS),
												...(callOptions.abortSignal
													? [callOptions.abortSignal]
													: []),
											]),
										}),
									),
							}
						: {}),
				} as ToolSet[string];
			}
		} catch {
			unavailable.push(server.name);
		}
	}
	return {
		tools,
		catalog,
		purposes,
		unavailable,
		close: async () => {
			await Promise.allSettled(clients.map((client) => client.close()));
		},
	};
}
