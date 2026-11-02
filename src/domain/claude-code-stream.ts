import type { ApiAgentEvent } from "./api-agent-event";
import type { ApiTokenUsage } from "./api-token-usage";

/** The MCP server name Claude Code knows ytimesy's own tools by. */
export const CLAUDE_CODE_MCP_SERVER = "ytimesy";
const MCP_PREFIX = `mcp__${CLAUDE_CODE_MCP_SERVER}__`;

export type ClaudeCodePlanStep = {
	readonly step: string;
	readonly status: "pending" | "in_progress" | "completed";
};

export type ClaudeCodeFailure = "usage-limit" | "refused" | "error";

export type ClaudeCodeResult = {
	readonly ok: boolean;
	readonly subtype: string;
	readonly text: string;
	readonly sessionId: string | null;
	readonly usage: ApiTokenUsage | null;
	readonly failure?: ClaudeCodeFailure;
	readonly resetsAt?: number | null;
};

/** What one stream-json line means for the chat. */
export type ClaudeCodeEffect =
	| { readonly kind: "event"; readonly event: ApiAgentEvent }
	| { readonly kind: "plan"; readonly plan: readonly ClaudeCodePlanStep[] }
	| {
			readonly kind: "session";
			readonly sessionId: string;
			/** MCP servers that failed to connect (ytimesy's own tools are then missing). */
			readonly failedMcpServers: readonly string[];
	  }
	| { readonly kind: "result"; readonly result: ClaudeCodeResult };

type Block = Record<string, unknown> & { type?: unknown };

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function blocks(message: unknown): Block[] {
	const content = record(message)?.content;
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content)
		? content.filter((block): block is Block => Boolean(record(block)))
		: [];
}

/** A tool result's text: Claude Code sends a string or text parts. */
function resultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const row = record(part);
			if (row?.type === "text" && typeof row.text === "string") return row.text;
			if (row?.type === "image") return "[image]";
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

const TODO_STATUSES = new Set(["pending", "in_progress", "completed"]);

function todoPlan(input: unknown): ClaudeCodePlanStep[] | null {
	const todos = record(input)?.todos;
	if (!Array.isArray(todos)) return null;
	const plan = todos.flatMap((todo) => {
		const row = record(todo);
		const step = typeof row?.content === "string" ? row.content.trim() : "";
		const status = typeof row?.status === "string" ? row.status : "";
		return step && TODO_STATUSES.has(status)
			? [
					{
						step: step.slice(0, 300),
						status: status as ClaudeCodePlanStep["status"],
					},
				]
			: [];
	});
	return plan.slice(0, 30);
}

function count(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: 0;
}

/** Claude Code's result usage as the chat's usage record. */
export function claudeCodeUsage(value: unknown): ApiTokenUsage | null {
	const usage = record(value);
	if (!usage) return null;
	const uncached = count(usage.input_tokens);
	const cacheRead = count(usage.cache_read_input_tokens);
	const cacheWrite = count(usage.cache_creation_input_tokens);
	return {
		inputTokens: uncached + cacheRead + cacheWrite,
		outputTokens: count(usage.output_tokens),
		uncachedInputTokens: uncached,
		cacheReadTokens: cacheRead,
		cacheWriteTokens: cacheWrite,
	};
}

/** Why a finished run failed, from its result text (never shown verbatim). */
export function claudeCodeFailure(text: string): {
	failure: ClaudeCodeFailure;
	resetsAt: number | null;
} {
	if (
		/usage limit|limit reached|out of (extra )?usage|limit will reset/i.test(
			text,
		)
	) {
		const epoch = /\|(\d{10})\b/.exec(text)?.[1];
		return {
			failure: "usage-limit",
			resetsAt: epoch ? Number(epoch) * 1000 : null,
		};
	}
	if (
		/\b40[13]\b|authentication_error|permission_error|invalid api key|oauth token|\/login|invalid bearer|token (has )?expired/i.test(
			text,
		)
	)
		return { failure: "refused", resetsAt: null };
	return { failure: "error", resetsAt: null };
}

/**
 * One stream-json line's effects. `lineKey` (the line's byte offset in the
 * run's output) makes text and reasoning ids stable when a step re-reads a
 * line after a restart. Subagent traffic (Claude Code's own Task tool) has a
 * parent tool id and stays inside that tool's card. ytimesy's own MCP tools
 * show from the bridge that runs them, never twice.
 */
export function claudeCodeEffects(
	line: string,
	lineKey: string,
	context: { readonly toolName: (id: string) => string | undefined },
): ClaudeCodeEffect[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return [];
	}
	const event = record(parsed);
	if (!event) return [];
	if (event.type === "system" && event.subtype === "init") {
		const sessionId =
			typeof event.session_id === "string" ? event.session_id : null;
		if (!sessionId) return [];
		const servers = Array.isArray(event.mcp_servers) ? event.mcp_servers : [];
		return [
			{
				kind: "session",
				sessionId,
				failedMcpServers: servers.flatMap((server) => {
					const row = record(server);
					return row &&
						typeof row.name === "string" &&
						row.status !== "connected"
						? [row.name]
						: [];
				}),
			},
		];
	}
	if (event.type === "result") {
		const text = typeof event.result === "string" ? event.result : "";
		const ok = event.is_error !== true && event.subtype === "success";
		const failure = ok ? null : claudeCodeFailure(text);
		return [
			{
				kind: "result",
				result: {
					ok,
					subtype: typeof event.subtype === "string" ? event.subtype : "",
					text,
					sessionId:
						typeof event.session_id === "string" ? event.session_id : null,
					usage: claudeCodeUsage(event.usage),
					...(failure
						? { failure: failure.failure, resetsAt: failure.resetsAt }
						: {}),
				},
			},
		];
	}
	if (event.parent_tool_use_id) return [];
	if (event.type === "assistant") {
		const effects: ClaudeCodeEffect[] = [];
		blocks(event.message).forEach((block, index) => {
			const id = `cc-${lineKey}-${index}`;
			if (block.type === "text" && typeof block.text === "string") {
				if (block.text.trim())
					effects.push({
						kind: "event",
						event: { type: "text-delta", id, text: block.text },
					});
			} else if (
				block.type === "thinking" &&
				typeof block.thinking === "string" &&
				block.thinking.trim()
			) {
				effects.push(
					{
						kind: "event",
						event: { type: "reasoning-delta", id, text: block.thinking },
					},
					{
						kind: "event",
						event: { type: "reasoning-end", id, durationSeconds: 0 },
					},
				);
			} else if (
				block.type === "tool_use" &&
				typeof block.id === "string" &&
				typeof block.name === "string"
			) {
				if (block.name.startsWith(MCP_PREFIX)) return;
				if (block.name === "TodoWrite") {
					const plan = todoPlan(block.input);
					if (plan?.length) effects.push({ kind: "plan", plan });
					return;
				}
				effects.push({
					kind: "event",
					event: {
						type: "tool-call",
						id: block.id,
						name: block.name,
						input: block.input ?? {},
					},
				});
			}
		});
		return effects;
	}
	if (event.type === "user") {
		return blocks(event.message).flatMap((block): ClaudeCodeEffect[] => {
			if (block.type !== "tool_result" || typeof block.tool_use_id !== "string")
				return [];
			const name = context.toolName(block.tool_use_id);
			// A call the chat never showed (ytimesy's own tools, TodoWrite).
			if (!name) return [];
			return [
				{
					kind: "event",
					event: {
						type: "tool-result",
						id: block.tool_use_id,
						name,
						output: resultText(block.content),
						...(block.is_error === true ? { failed: true } : {}),
					},
				},
			];
		});
	}
	return [];
}

type PromptMessage = { readonly role: string; readonly content: unknown };

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const row = record(part);
			if (row?.type === "text" && typeof row.text === "string") return row.text;
			if (row?.type === "image" || row?.type === "file")
				return "[An attached file is in the chat's attachments folder.]";
			return "";
		})
		.filter(Boolean)
		.join("\n\n");
}

const HISTORY_CHARACTERS = 40_000;

/**
 * What a run sends Claude Code on stdin: the user messages since the last
 * answer. A run that cannot resume an earlier session (the chat's first
 * Claude Code turn, a switch from another model, a lost transcript) also
 * gets the conversation so far, newest last, bounded.
 */
export function claudeCodePrompt(
	messages: readonly PromptMessage[],
	resuming: boolean,
): string {
	let lastAnswer = messages.length - 1;
	while (lastAnswer >= 0 && messages[lastAnswer]?.role !== "assistant")
		lastAnswer--;
	const request = messages
		.slice(lastAnswer + 1)
		.filter((message) => message.role === "user")
		.map((message) => messageText(message.content).trim())
		.filter(Boolean)
		.join("\n\n");
	if (resuming || lastAnswer < 0) return request;
	const earlier: string[] = [];
	let used = 0;
	for (
		let index = lastAnswer;
		index >= 0 && used < HISTORY_CHARACTERS;
		index--
	) {
		const message = messages[index];
		if (!message || (message.role !== "user" && message.role !== "assistant"))
			continue;
		const text = messageText(message.content).trim();
		if (!text) continue;
		const entry =
			`${message.role === "user" ? "User" : "Assistant"}: ${text}`.slice(
				0,
				HISTORY_CHARACTERS - used,
			);
		used += entry.length;
		earlier.unshift(entry);
	}
	return earlier.length
		? `Earlier in this chat, for context:\n\n${earlier.join("\n\n")}\n\nThe request now:\n\n${request}`
		: request;
}

/** Claude Code's per-project directory name for a working directory. */
export function claudeCodeProjectDirectory(cwd: string) {
	return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Claude Code session ids are UUIDs; anything else is never used in a path. */
export function isClaudeCodeSessionId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
	);
}

/** ytimesy's MCP tool name as Claude Code calls it. */
export function claudeCodeMcpToolName(name: string) {
	return `${MCP_PREFIX}${name}`;
}
