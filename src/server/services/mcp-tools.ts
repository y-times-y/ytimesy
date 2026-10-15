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

/** What one server offered: reusable across a turn's steps (no live connection). */
export type McpServerListing = {
	instructions?: string;
	tools: { name: string; definition: ToolSet[string] }[];
	catalog: Omit<McpCatalogEntry, "server" | "name">[];
};

/**
 * Connects the user's remote MCP servers from our server for one turn. Their
 * credentials stay here; the workspace VM never sees them. A server that fails
 * to connect is skipped and reported, so it cannot block the run.
 *
 * With `listing`, a server's tool list is kept for the turn: later steps offer
 * the same tools without connecting, and connect (and list again, so the call
 * uses the server's current definitions) only when one of them is called.
 */
export async function connectMcpTools(
	servers: readonly (ConnectableMcpServer & { key?: string })[],
	options: {
		fetch?: typeof globalThis.fetch;
		signal?: AbortSignal;
		listing?: (
			key: string,
			load: () => Promise<McpServerListing>,
		) => Promise<McpServerListing>;
	} = {},
) {
	const clients: MCPClient[] = [];
	const tools: ToolSet = {};
	const catalog: McpCatalogEntry[] = [];
	/** Each server's own initialize instructions, when it gave any. */
	const purposes: Record<string, string> = {};
	const unavailable: string[] = [];
	const connect = async (server: ConnectableMcpServer) => {
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
		const listed = await withinConnectTimeout(client.tools(), options.signal);
		return { client, listed };
	};
	for (const server of servers) {
		try {
			// This step's live tools for the server, connected at most once.
			let live: Promise<ToolSet> | undefined;
			const liveTools = () => {
				if (!live) {
					const started = connect(server).then(({ listed }) => listed);
					live = started;
					// A failed connection is retried by the next call.
					started.catch(() => {
						if (live === started) live = undefined;
					});
				}
				return live;
			};
			const load = async (): Promise<McpServerListing> => {
				const { client, listed } = await connect(server);
				live = Promise.resolve(listed);
				const entries = Object.entries(listed);
				return {
					instructions: client.instructions?.trim() || undefined,
					tools: entries.map(([name, definition]) => ({ name, definition })),
					catalog: await Promise.all(
						entries.map(async ([name, definition]) => ({
							tool: name,
							description:
								typeof definition.description === "string"
									? definition.description
									: "",
							inputSchema: await asSchema(definition.inputSchema).jsonSchema,
						})),
					),
				};
			};
			const listing =
				options.listing && server.key
					? await options.listing(server.key, load)
					: await load();
			if (listing.instructions) purposes[server.name] = listing.instructions;
			for (const entry of listing.catalog)
				catalog.push({
					...entry,
					name: mcpToolName(server.name, entry.tool),
					server: server.name,
				});
			for (const { name, definition } of listing.tools) {
				const execute = definition.execute;
				tools[mcpToolName(server.name, name)] = {
					...definition,
					description: `[MCP ${server.name}] ${definition.description ?? name}`,
					...(execute
						? {
								execute: async (
									input: unknown,
									callOptions: Parameters<typeof execute>[1],
								) => {
									const current = (await liveTools())[name]?.execute;
									if (!current)
										throw new Error(
											`MCP server ${server.name} no longer offers ${name}.`,
										);
									return bounded(
										await current(input as never, {
											...callOptions,
											abortSignal: AbortSignal.any([
												AbortSignal.timeout(CALL_TIMEOUT_MS),
												...(callOptions.abortSignal
													? [callOptions.abortSignal]
													: []),
											]),
										}),
									);
								},
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

/** Listing tools has no signal of its own; a stalled server must not hold the step. */
function withinConnectTimeout<T>(work: Promise<T>, signal?: AbortSignal) {
	const deadline = AbortSignal.any([
		AbortSignal.timeout(CONNECT_TIMEOUT_MS),
		...(signal ? [signal] : []),
	]);
	return new Promise<T>((resolve, reject) => {
		const stop = () => reject(new Error("MCP tool listing timed out."));
		if (deadline.aborted) return stop();
		deadline.addEventListener("abort", stop, { once: true });
		work
			.then(resolve, reject)
			.finally(() => deadline.removeEventListener("abort", stop));
	});
}
