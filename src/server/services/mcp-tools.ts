import {
	createMCPClient,
	type MCPClient,
	type OAuthClientProvider,
} from "@ai-sdk/mcp";
import type { ToolSet } from "ai";
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
// Provider tool names allow [A-Za-z0-9_-] up to 64 characters.
const toolName = (server: string, tool: string) =>
	`mcp__${server}__${tool.replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 64);

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
			for (const [name, definition] of Object.entries(await client.tools())) {
				const execute = definition.execute;
				tools[toolName(server.name, name)] = {
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
		unavailable,
		close: async () => {
			await Promise.allSettled(clients.map((client) => client.close()));
		},
	};
}
