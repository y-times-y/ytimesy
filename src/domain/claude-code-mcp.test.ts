import { describe, expect, it, vi } from "vitest";
import { CLAUDE_CODE_INBOX_METHOD, handleMcpMessage } from "./claude-code-mcp";

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

	it("answers the run's hooks with the messages sent meanwhile, never as a tool", async () => {
		const server = { ...handlers(), inbox: vi.fn(async () => "Use pnpm.") };
		const reply = await handleMcpMessage(
			{ jsonrpc: "2.0", id: 9, method: CLAUDE_CODE_INBOX_METHOD },
			server,
		);
		expect(reply.body).toMatchObject({ id: 9, result: { text: "Use pnpm." } });
		const list = await handleMcpMessage(
			{ jsonrpc: "2.0", id: 10, method: "tools/list" },
			server,
		);
		expect(JSON.stringify(list.body)).not.toContain("inbox");
		// A server without an inbox has nothing waiting.
		expect(
			(
				await handleMcpMessage(
					{ jsonrpc: "2.0", id: 11, method: CLAUDE_CODE_INBOX_METHOD },
					handlers(),
				)
			).body,
		).toMatchObject({ result: { text: "" } });
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

	it("keeps model invocation IDs separate from RPC counters and arguments", async () => {
		const server = handlers();
		for (const invocationId of ["toolu_parallel_a", "toolu_parallel_b"])
			await handleMcpMessage(
				{
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: {
						name: "agent",
						arguments: { brief: "same" },
						_meta: { "claudecode/toolUseId": invocationId },
					},
				},
				server,
			);
		expect(server.call.mock.calls).toEqual([
			["agent", { brief: "same" }, "toolu_parallel_a"],
			["agent", { brief: "same" }, "toolu_parallel_b"],
		]);
	});

	it.each([null, false, 42, "", {}])(
		"refuses malformed native invocation ID %j before execution",
		async (invocationId) => {
			const server = handlers();
			expect(
				await handleMcpMessage(
					{
						jsonrpc: "2.0",
						id: 9,
						method: "tools/call",
						params: {
							name: "agent",
							arguments: {},
							_meta: { "claudecode/toolUseId": invocationId },
						},
					},
					server,
				),
			).toMatchObject({ body: { error: { code: -32602 } } });
			expect(server.call).not.toHaveBeenCalled();
		},
	);

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
