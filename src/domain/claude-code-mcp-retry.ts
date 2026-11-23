import { PLAN_TOOL } from "./agent-todos";
import { CLAUDE_CODE_INBOX_METHOD } from "./claude-code-mcp";
import { SEARCH_MCP_TOOLS_TOOL } from "./mcp-tool-call";
import {
	Y_SQUARED_MESSAGE_THREAD_TOOL,
	Y_SQUARED_READ_CANVAS_TOOL,
	Y_SQUARED_START_THREAD_TOOL,
	Y_SQUARED_THREAD_TOOL,
	Y_SQUARED_THREADS_TOOL,
} from "./y-squared";
import { Y_SQUARED_VIEW_IMAGE_TOOL } from "./y-squared-images";

/**
 * Whether one MCP message of a Claude Code run may be sent again when the
 * hop to the chat's Durable Object fails (the object reset for a deploy or
 * for memory, 2026-11-21/23: the run saw "Error POSTing to endpoint:").
 * Only what has no effect, or whose effect the second send cannot repeat,
 * is: a write that may already have run is never sent twice.
 */
export type McpMessageRetry = {
	/** The JSON-RPC id, or undefined for a notification. */
	readonly id: unknown;
	/** What the message asks, for messages and logs ("tools/call threads"). */
	readonly label: string;
	readonly toolCall: boolean;
	readonly repeatable: boolean;
};

/** Tools that only read. */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
	Y_SQUARED_THREADS_TOOL,
	Y_SQUARED_THREAD_TOOL,
	Y_SQUARED_READ_CANVAS_TOOL,
	Y_SQUARED_VIEW_IMAGE_TOOL,
	SEARCH_MCP_TOOLS_TOOL,
	// Replaces the whole plan: the same call twice leaves the same plan.
	PLAN_TOOL,
]);

/**
 * Tools whose send carries a key made of the turn and the content
 * (y-squared-tools.ts `sendKey`): a second send in the same turn finds the
 * first (`alreadySent`, `chatHoldingSend`) instead of sending again.
 */
const KEYED_SEND_TOOLS: ReadonlySet<string> = new Set([
	Y_SQUARED_START_THREAD_TOOL,
	Y_SQUARED_MESSAGE_THREAD_TOOL,
]);

/** Methods with no effect (the inbox only reads what the user sent). */
const REPEATABLE_METHODS: ReadonlySet<string> = new Set([
	"initialize",
	"ping",
	"tools/list",
	CLAUDE_CODE_INBOX_METHOD,
]);

export function mcpMessageRetry(message: unknown): McpMessageRetry {
	const row =
		message && typeof message === "object" && !Array.isArray(message)
			? (message as Record<string, unknown>)
			: {};
	const method = typeof row.method === "string" ? row.method : "";
	const id = row.id;
	if (id === undefined)
		// A notification (the object only acknowledges it), or no message at
		// all (refused before anything runs: a batch, a GET).
		return {
			id,
			label: method || "request",
			toolCall: false,
			repeatable: true,
		};
	if (method !== "tools/call")
		return {
			id,
			label: method || "request",
			toolCall: false,
			repeatable: REPEATABLE_METHODS.has(method),
		};
	const params =
		row.params && typeof row.params === "object"
			? (row.params as Record<string, unknown>)
			: {};
	const name = typeof params.name === "string" ? params.name : "";
	const args =
		params.arguments && typeof params.arguments === "object"
			? (params.arguments as Record<string, unknown>)
			: {};
	return {
		id,
		label: `tools/call ${name || "(unnamed)"}`,
		toolCall: true,
		repeatable:
			READ_ONLY_TOOLS.has(name) ||
			(KEYED_SEND_TOOLS.has(name) &&
				// Interrupt stops the thread's turn before sending: a second
				// call would stop the turn the first one started.
				args.mode !== "interrupt"),
	};
}
