import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { asSchema, jsonSchema, type ToolSet } from "ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyApiProgress } from "#/domain/api-progress";
import { notionMcpTools } from "../../../tests/fixtures/notion-mcp-tools";
import { estimateContextTokens } from "./api-agent-context";
import {
	inlineMcpTokens,
	mcpSchemaIssues,
	mcpToolSurface,
	searchMcpCatalog,
} from "./mcp-tool-surface";
import { connectMcpTools } from "./mcp-tools";
import { withRedactedResults } from "./redacted-tools";

let server: Server;
let url: string;
const calls: { name?: string; arguments?: unknown }[] = [];

// A Streamable-HTTP MCP server serving the Notion-shaped fixture.
beforeAll(async () => {
	server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			if (request.method !== "POST") {
				response.writeHead(405).end();
				return;
			}
			const message = JSON.parse(body) as {
				id?: number;
				method: string;
				params?: {
					name?: string;
					arguments?: Record<string, unknown>;
					protocolVersion?: string;
				};
			};
			if (message.id === undefined) {
				response.writeHead(202).end();
				return;
			}
			const reply = (result: unknown) => {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(
					JSON.stringify({ jsonrpc: "2.0", id: message.id, result }),
				);
			};
			if (message.method === "initialize")
				return reply({
					protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
					capabilities: { tools: {} },
					serverInfo: { name: "notion", version: "1.0.0" },
					instructions:
						"Notion workspace: search, read and write pages and databases. Fetch before you update.",
				});
			if (message.method === "tools/list")
				return reply({ tools: notionMcpTools });
			if (message.method === "tools/call") {
				calls.push({
					name: message.params?.name,
					arguments: message.params?.arguments,
				});
				if (message.params?.arguments?.query === "reject")
					return reply({
						isError: true,
						content: [{ type: "text", text: "invalid query" }],
					});
				return reply({
					content: [
						{
							type: "text",
							text: `${message.params?.name}: found sk-live-secret`,
						},
					],
				});
			}
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: message.id,
					error: { code: -32601, message: "Method not found" },
				}),
			);
		});
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});
afterAll(() => new Promise<void>((done) => server.close(() => done())));

const options = {
	toolCallId: "call",
	messages: [],
	abortSignal: new AbortController().signal,
	context: {},
};

const core: ToolSet = {
	execute_command: {
		description: "Run a shell command.",
		inputSchema: jsonSchema({
			type: "object",
			properties: { command: { type: "string" } },
		}),
		execute: async () => "ok",
	} as ToolSet[string],
};

async function definitionTokens(tools: ToolSet) {
	return estimateContextTokens(
		await Promise.all(
			Object.entries(tools).map(async ([name, definition]) => ({
				name,
				description: definition.description,
				schema: await asSchema(definition.inputSchema).jsonSchema,
			})),
		),
	);
}

async function connectNotion() {
	return connectMcpTools([{ name: "notion", url, headers: {} }]);
}

describe("deferred MCP tools", () => {
	it("offers no per-tool schemas for a large server, only a bounded catalog and two fixed tools", async () => {
		const mcp = await connectNotion();
		try {
			const inline = { ...core, ...mcp.tools };
			const offered = mcpToolSurface({
				tools: inline,
				catalog: mcp.catalog,
				purposes: mcp.purposes,
			});
			expect(Object.keys(offered).sort()).toEqual([
				"call_mcp_tool",
				"execute_command",
				"search_mcp_tools",
			]);
			const listing = offered.search_mcp_tools.description ?? "";
			expect(listing).toContain(
				"- notion (Notion workspace: search, read and write pages and databases.): 14 tools: notion-search, notion-fetch",
			);
			expect(listing).not.toContain("Notion-flavored Markdown");
			const before = await definitionTokens(inline);
			const after = await definitionTokens(offered);
			// Measured with this fixture: about 6,400 inline vs 500 deferred.
			expect(before).toBeGreaterThan(5 * after);
		} finally {
			await mcp.close();
		}
	});

	it("keeps a small MCP setup's real tools inline", async () => {
		const mcp = await connectNotion();
		try {
			const small = mcp.catalog.filter((entry) =>
				["notion-get-self", "notion-duplicate-page"].includes(entry.tool),
			);
			expect(inlineMcpTokens(small)).toBeLessThan(2_000);
			const tools = { ...core, ...mcp.tools };
			expect(mcpToolSurface({ tools, catalog: small })).toBe(tools);
		} finally {
			await mcp.close();
		}
	});

	it("builds the same tool list every step, so the cached prefix holds", async () => {
		const first = await connectNotion();
		const second = await connectNotion();
		try {
			const shape = async (mcp: Awaited<ReturnType<typeof connectNotion>>) =>
				JSON.stringify(
					await Promise.all(
						Object.entries(
							mcpToolSurface({
								tools: { ...core, ...mcp.tools },
								catalog: mcp.catalog,
								purposes: mcp.purposes,
							}),
						).map(async ([name, definition]) => [
							name,
							definition.description,
							await asSchema(definition.inputSchema).jsonSchema,
						]),
					),
				);
			expect(await shape(second)).toBe(await shape(first));
		} finally {
			await Promise.all([first.close(), second.close()]);
		}
	});

	it("search ranks tools by name and description and returns their schemas", async () => {
		const mcp = await connectNotion();
		try {
			expect(
				searchMcpCatalog(mcp.catalog, "create page")
					.slice(0, 1)
					.map((entry) => entry.tool),
			).toEqual(["notion-create-pages"]);
			const offered = mcpToolSurface({
				tools: mcp.tools,
				catalog: mcp.catalog,
			});
			const result = (await offered.search_mcp_tools.execute?.(
				{ query: "notion-fetch" },
				options,
			)) as { tools: { tool: string; inputSchema: unknown }[] };
			expect(result.tools[0]).toMatchObject({
				tool: "notion-fetch",
				inputSchema: { required: ["id"] },
			});
		} finally {
			await mcp.close();
		}
	});

	it("validates arguments and returns the schema so the model can correct itself", () => {
		const schema = notionMcpTools[0].inputSchema as never;
		expect(mcpSchemaIssues(schema, { query: "roadmap", page_size: 5 })).toEqual(
			[],
		);
		expect(mcpSchemaIssues(schema, { q: "roadmap", page_size: "5" })).toEqual([
			"arguments.query: required",
			"arguments.q: unknown property",
			"arguments.page_size: expected integer, got string",
		]);
	});

	it("routes a valid call through the wrapped real tool and its client", async () => {
		const mcp = await connectNotion();
		try {
			const seen: string[] = [];
			// Stands in for hooks.wrap: wrappers apply under the real MCP name.
			const hooked = Object.fromEntries(
				Object.entries(
					withRedactedResults({ ...core, ...mcp.tools }, ["sk-live-secret"]),
				).map(([name, definition]) => [
					name,
					{
						...definition,
						execute: async (args: unknown, callOptions: never) => {
							seen.push(name);
							if (name === "mcp__notion__notion-create-pages")
								return { blocked: true, error: "Blocked by PreToolUse" };
							return definition.execute?.(args as never, callOptions);
						},
					},
				]),
			) as ToolSet;
			const offered = mcpToolSurface({ tools: hooked, catalog: mcp.catalog });
			calls.length = 0;
			const invalid = (await offered.call_mcp_tool.execute?.(
				{ server: "notion", tool: "notion-search", arguments: { q: "x" } },
				options,
			)) as { isError: boolean; issues: string[]; inputSchema: unknown };
			expect(invalid.isError).toBe(true);
			expect(invalid.issues).toContain("arguments.query: required");
			expect(invalid.inputSchema).toMatchObject({ required: ["query"] });
			expect(calls).toEqual([]);

			const output = await offered.call_mcp_tool.execute?.(
				{
					server: "notion",
					tool: "notion-search",
					arguments: { query: "roadmap" },
				},
				options,
			);
			expect(calls).toEqual([
				{ name: "notion-search", arguments: { query: "roadmap" } },
			]);
			expect(JSON.stringify(output)).toContain(
				"notion-search: found [REDACTED",
			);
			const modelOutput = await offered.call_mcp_tool.toModelOutput?.({
				toolCallId: "call",
				input: {
					server: "notion",
					tool: "notion-search",
					arguments: { query: "roadmap" },
				},
				output,
			});
			expect(modelOutput).toMatchObject({ type: "content" });

			const rejected = (await offered.call_mcp_tool.execute?.(
				{
					server: "notion",
					tool: "notion-search",
					arguments: { query: "reject" },
				},
				options,
			)) as { isError: boolean; inputSchema: unknown };
			expect(rejected).toMatchObject({
				isError: true,
				inputSchema: { required: ["query"] },
			});

			expect(
				await offered.call_mcp_tool.execute?.(
					{
						server: "notion",
						tool: "notion-create-pages",
						arguments: { pages: [{ properties: { title: "x" } }] },
					},
					options,
				),
			).toEqual({ blocked: true, error: "Blocked by PreToolUse" });
			expect(seen).toEqual([
				"mcp__notion__notion-search",
				"mcp__notion__notion-search",
				"mcp__notion__notion-create-pages",
			]);

			const unknown = (await offered.call_mcp_tool.execute?.(
				{ server: "notion", tool: "notion-delete", arguments: {} },
				options,
			)) as { isError: boolean; tools: string[] };
			expect(unknown.isError).toBe(true);
			expect(unknown.tools).toContain("notion-fetch");
		} finally {
			await mcp.close();
		}
	});

	it("shows a generic call in the transcript as the MCP tool it named", () => {
		let items = applyApiProgress([], "turn", {
			type: "tool-call",
			id: "c1",
			name: "call_mcp_tool",
			input: {
				server: "notion",
				tool: "notion-search",
				arguments: { query: "roadmap" },
			},
		});
		items = applyApiProgress(items, "turn", {
			type: "tool-result",
			id: "c1",
			name: "call_mcp_tool",
			output: { content: [] },
		});
		expect(items).toEqual([
			expect.objectContaining({
				kind: "dynamicToolCall",
				tool: "mcp__notion__notion-search",
				input: JSON.stringify({ query: "roadmap" }, null, 2),
				status: "completed",
			}),
		]);
	});
});
