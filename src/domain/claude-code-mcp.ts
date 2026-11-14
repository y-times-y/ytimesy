/**
 * A minimal MCP server (Streamable HTTP, JSON responses only) for the tools
 * ytimesy adds to Claude Code: subagents, the plan, secret requests,
 * questions, the project environment and the user's own MCP tools. Each
 * POST is one JSON-RPC message; notifications get 202 and no body.
 */
export type McpToolDefinition = {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
};

/** One block of a tool result: text, or an image the model should see as pixels. */
export type McpContentBlock =
	| { readonly type: "text"; readonly text: string }
	| {
			readonly type: "image";
			readonly data: string;
			readonly mimeType: string;
	  };

export type McpCallResult = {
	readonly text: string;
	readonly isError: boolean;
	/** Replaces `text` as the result's content when present (images as pixels). */
	readonly content?: readonly McpContentBlock[];
};

/**
 * Not an MCP method: the run's PostToolUse and Stop hooks (claude-agent-runner.ts)
 * ask with it for messages the user sent (Send on a queued message) while the
 * run works. Never listed as a tool, so the model cannot call it.
 */
export const CLAUDE_CODE_INBOX_METHOD = "ytimesy/inbox";

export type McpServerHandlers = {
	readonly tools: () => Promise<readonly McpToolDefinition[]>;
	/** The text for the model now; empty when nothing waits. */
	readonly inbox?: () => Promise<string>;
	readonly call: (
		name: string,
		args: Record<string, unknown>,
	) => Promise<McpCallResult>;
};

export type McpReply = { readonly status: number; readonly body?: unknown };

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

function error(id: unknown, code: number, message: string): McpReply {
	return {
		status: 200,
		body: { jsonrpc: "2.0", id: id ?? null, error: { code, message } },
	};
}

export async function handleMcpMessage(
	message: unknown,
	handlers: McpServerHandlers,
): Promise<McpReply> {
	if (!message || typeof message !== "object" || Array.isArray(message))
		return error(null, -32600, "Invalid request.");
	const { jsonrpc, id, method, params } = message as {
		jsonrpc?: unknown;
		id?: unknown;
		method?: unknown;
		params?: unknown;
	};
	if (jsonrpc !== "2.0" || typeof method !== "string")
		return error(id, -32600, "Invalid request.");
	// A notification (initialized, cancelled) or a response to us: no reply.
	if (id === undefined) return { status: 202 };
	const result = (value: unknown): McpReply => ({
		status: 200,
		body: { jsonrpc: "2.0", id, result: value },
	});
	const input = (params ?? {}) as Record<string, unknown>;
	switch (method) {
		case "initialize": {
			const requested =
				typeof input.protocolVersion === "string" ? input.protocolVersion : "";
			return result({
				protocolVersion: SUPPORTED_VERSIONS.includes(requested)
					? requested
					: SUPPORTED_VERSIONS[0],
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: "ytimesy", version: "1.0.0" },
			});
		}
		case "ping":
			return result({});
		case CLAUDE_CODE_INBOX_METHOD:
			return result({ text: handlers.inbox ? await handlers.inbox() : "" });
		case "tools/list":
			return result({ tools: await handlers.tools() });
		case "tools/call": {
			const name = typeof input.name === "string" ? input.name : "";
			const args =
				input.arguments &&
				typeof input.arguments === "object" &&
				!Array.isArray(input.arguments)
					? (input.arguments as Record<string, unknown>)
					: {};
			if (!name) return error(id, -32602, "Missing tool name.");
			const known = (await handlers.tools()).some((tool) => tool.name === name);
			if (!known) return error(id, -32602, `Unknown tool: ${name}`);
			const called = await handlers.call(name, args);
			return result({
				content: called.content?.length
					? called.content
					: [{ type: "text", text: called.text }],
				isError: called.isError,
			});
		}
		default:
			return error(id, -32601, `Method not found: ${method}`);
	}
}
