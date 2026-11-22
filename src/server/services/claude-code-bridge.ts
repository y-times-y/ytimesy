import type { ToolSet } from "ai";
import type { ApiAgentEvent } from "#/domain/api-agent-event";
import type {
	McpCallResult,
	McpToolDefinition,
} from "#/domain/claude-code-mcp";
import { runToolForMcp } from "./mcp-tool-call";

export { mcpToolDefinitions } from "./mcp-tool-call";

/**
 * ytimesy's own tools for a running Claude Code turn, served to the VM's
 * Claude Code over MCP. The edge routes a chat's MCP requests to the chat's
 * Durable Object, which also runs the turn's steps. A request never runs a
 * tool itself: on Workers an invocation must not use I/O another one opened
 * (the step's database pool, its MCP clients, its progress writer). It
 * queues the call here; the running step takes it, runs it in its own
 * context (shown in the timeline like any tool call) and answers.
 * Between steps calls wait for the next step.
 */
export type ClaudeCodeCallReply = McpCallResult;

export type ClaudeCodeCall = {
	readonly name: string;
	readonly args: Record<string, unknown>;
	readonly invocationId?: string;
	readonly reply: (value: ClaudeCodeCallReply) => void;
	/** Taken by a step: a timed-out response no longer proves it did not run. */
	started?: boolean;
};

type TurnBridge = {
	definitions: readonly McpToolDefinition[] | null;
	readonly queue: ClaudeCodeCall[];
	readonly listeners: Set<() => void>;
	calls: number;
};

const turns = new Map<string, TurnBridge>();

function bridge(turnId: string): TurnBridge {
	let found = turns.get(turnId);
	if (!found) {
		found = { definitions: null, queue: [], listeners: new Set(), calls: 0 };
		turns.set(turnId, found);
	}
	return found;
}

function notify(entry: TurnBridge) {
	for (const listener of [...entry.listeners]) listener();
}

/** Waits until `ready` holds or the time runs out; woken by any change. */
async function waitFor(
	entry: TurnBridge,
	ready: () => boolean,
	ms: number,
): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (!ready()) {
		const left = deadline - Date.now();
		if (left <= 0) return false;
		await new Promise<void>((resolve) => {
			const done = () => {
				clearTimeout(timer);
				entry.listeners.delete(done);
				resolve();
			};
			const timer = setTimeout(done, left);
			entry.listeners.add(done);
		});
	}
	return true;
}

/**
 * Calls `listener` whenever a call waits in the turn's queue, until the
 * returned function runs: a step on a turn box takes calls as they come
 * instead of between its (long) polls.
 */
export function onClaudeCodeCallQueued(turnId: string, listener: () => void) {
	const entry = bridge(turnId);
	const wrapped = () => {
		if (entry.queue.length > 0) listener();
	};
	entry.listeners.add(wrapped);
	return () => {
		entry.listeners.delete(wrapped);
	};
}

/** The step offers its tools (plain data, so any invocation may read them). */
export function publishClaudeCodeTools(
	turnId: string,
	definitions: readonly McpToolDefinition[],
) {
	const entry = bridge(turnId);
	entry.definitions = definitions;
	notify(entry);
}

/** The turn ended: pending calls are told so and nothing more is kept. */
export function closeClaudeCodeBridge(turnId: string) {
	const entry = turns.get(turnId);
	if (!entry) return;
	turns.delete(turnId);
	for (const call of entry.queue.splice(0))
		call.reply({ text: "This turn has ended.", isError: true });
	notify(entry);
}

export async function claudeCodeBridgeTools(
	turnId: string,
	waitMs = 30_000,
): Promise<readonly McpToolDefinition[] | null> {
	const entry = bridge(turnId);
	await waitFor(entry, () => entry.definitions !== null, waitMs);
	return entry.definitions;
}

/**
 * The run's hooks asking for messages the user sent meanwhile (never a
 * tool: no tool name starts with a NUL). The step answers it itself.
 */
export const CLAUDE_CODE_INBOX_CALL = "\u0000inbox";

/** How long a tool call may wait for its answer. */
export const CLAUDE_CODE_CALL_TIMEOUT_MS = 60 * 60_000;

/** Queues one call for the running step and waits for its answer. */
export function requestClaudeCodeCall(
	turnId: string,
	name: string,
	args: Record<string, unknown>,
	timeoutMs = CLAUDE_CODE_CALL_TIMEOUT_MS,
	/** A call the step took gets this much longer before it times out. */
	startedGraceMs = 0,
	invocationId?: string,
): Promise<ClaudeCodeCallReply> {
	const entry = bridge(turnId);
	return new Promise((resolve) => {
		let settled = false;
		let graced = false;
		const expire = () => {
			if (call.started && startedGraceMs > 0 && !graced) {
				graced = true;
				timer = setTimeout(expire, startedGraceMs);
				return;
			}
			reply({
				text: call.started
					? "The tool started but its reply timed out. Its outcome is unknown; inspect workspace state and tracked jobs before retrying. Do not blindly repeat a command that may have changed files or external systems."
					: "ytimesy did not start this tool before its queue timeout; it was removed from the queue.",
				isError: true,
			});
		};
		let timer = setTimeout(expire, timeoutMs);
		const reply = (value: ClaudeCodeCallReply) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			const index = entry.queue.indexOf(call);
			if (index >= 0) entry.queue.splice(index, 1);
			resolve(value);
		};
		const call: ClaudeCodeCall = {
			name,
			args,
			reply,
			...(invocationId === undefined ? {} : { invocationId }),
		};
		entry.queue.push(call);
		notify(entry);
	});
}

/** The calls waiting for the step; each is taken once. */
export function takeClaudeCodeCalls(turnId: string): ClaudeCodeCall[] {
	const calls = turns.get(turnId)?.queue.splice(0) ?? [];
	for (const call of calls) call.started = true;
	return calls;
}

export function pendingClaudeCodeCalls(turnId: string) {
	return turns.get(turnId)?.queue.length ?? 0;
}

/** Sleeps up to `ms`, returning early when a call arrives. */
export async function waitForClaudeCodeCall(turnId: string, ms: number) {
	const entry = bridge(turnId);
	await waitFor(entry, () => entry.queue.length > 0, ms);
}

/**
 * Runs one queued call in the step's context: validated like a model's
 * call, shown in the timeline (tool-call, then tool-result) under an id of
 * its own, and answered as text.
 */
export async function runClaudeCodeCall(
	turnId: string,
	call: ClaudeCodeCall,
	context: {
		readonly tools: ToolSet;
		readonly onEvent: (event: ApiAgentEvent) => Promise<void>;
		readonly signal: AbortSignal;
	},
): Promise<void> {
	const definition = context.tools[call.name];
	if (!definition?.execute) {
		call.reply({ text: `Unknown tool: ${call.name}`, isError: true });
		return;
	}
	const entry = bridge(turnId);
	entry.calls += 1;
	const id =
		call.invocationId === undefined
			? `ccmcp-${Date.now().toString(36)}-${entry.calls}`
			: `ccmcp-${call.invocationId}`;
	try {
		await context.onEvent({
			type: "tool-call",
			id,
			name: call.name,
			input: call.args,
		});
		const ran = await runToolForMcp(definition, call.name, call.args, {
			toolCallId: id,
			signal: context.signal,
		});
		await context.onEvent({
			type: "tool-result",
			id,
			name: call.name,
			output: ran.output,
			...(ran.failed ? { failed: true } : {}),
		});
		call.reply(ran.reply);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "The tool call failed.";
		await context
			.onEvent({
				type: "tool-result",
				id,
				name: call.name,
				output: message,
				failed: true,
			})
			.catch(() => undefined);
		call.reply({ text: message, isError: true });
	}
}
