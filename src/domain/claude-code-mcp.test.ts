import { describe, expect, it, vi } from "vitest";
import { handleMcpMessage } from "./claude-code-mcp";

const handlers = () => ({
	tools: vi.fn(async () => [
		{
			name: "agent",
			description: "Start a helper.",
			inputSchema: { type: "object" },
		},
	]),
	call: vi.fn(async () => ({ text: "started", isError: false })),
});

describe("ytimesy's MCP server for Claude Code", () => {
	it("initializes with the client's protocol version", async () => {
		const reply = await handleMcpMessage(
			{
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: "2025-03-26" },
			},
			handlers(),
		);
		expect(reply.body).toMatchObject({
			id: 1,
			result: {
				protocolVersion: "2025-03-26",
				capabilities: { tools: {} },
				serverInfo: { name: "ytimesy" },
			},
		});
	});

	it("acknowledges notifications without a body", async () => {
		expect(
			await handleMcpMessage(
				{ jsonrpc: "2.0", method: "notifications/initialized" },
				handlers(),
			),
		).toEqual({ status: 202 });
	});

	it("lists and calls the turn's tools", async () => {
		const server = handlers();
		const list = await handleMcpMessage(
			{ jsonrpc: "2.0", id: 2, method: "tools/list" },
			server,
		);
		expect(list.body).toMatchObject({
			result: { tools: [{ name: "agent" }] },
		});
		const call = await handleMcpMessage(
			{
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "agent", arguments: { brief: "Look" } },
			},
			server,
		);
		expect(server.call).toHaveBeenCalledWith("agent", { brief: "Look" });
		expect(call.body).toMatchObject({
			result: { content: [{ type: "text", text: "started" }], isError: false },
		});
	});

	it("refuses unknown tools, methods and malformed messages", async () => {
		const server = handlers();
		expect(
			await handleMcpMessage(
				{
					jsonrpc: "2.0",
					id: 4,
					method: "tools/call",
					params: { name: "Bash" },
				},
				server,
			),
		).toMatchObject({ body: { error: { code: -32602 } } });
		expect(server.call).not.toHaveBeenCalled();
		expect(
			await handleMcpMessage(
				{ jsonrpc: "2.0", id: 5, method: "resources/list" },
				server,
			),
		).toMatchObject({ body: { error: { code: -32601 } } });
		expect(await handleMcpMessage([], server)).toMatchObject({
			body: { error: { code: -32600 } },
		});
	});
});
