import { asSchema, type Tool, type ToolSet } from "ai";
import type { ApiAgentEvent } from "#/domain/api-agent-event";
import type { McpToolDefinition } from "#/domain/claude-code-mcp";

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
type ExecuteOptions = Parameters<NonNullable<Tool["execute"]>>[1];

export type ClaudeCodeCallReply = { text: string; isError: boolean };

export type ClaudeCodeCall = {
	readonly name: string;
	readonly args: Record<string, unknown>;
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

/** Queues one call for the running step and waits for its answer. */
export function requestClaudeCodeCall(
	turnId: string,
	name: string,
	args: Record<string, unknown>,
	timeoutMs = 60 * 60_000,
): Promise<ClaudeCodeCallReply> {
	const entry = bridge(turnId);
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(
			() =>
				reply({
					text: call.started
						? "The tool started but its reply timed out. Its outcome is unknown; inspect workspace state and tracked jobs before retrying. Do not blindly repeat a command that may have changed files or external systems."
						: "ytimesy did not start this tool before its queue timeout; it was removed from the queue.",
					isError: true,
				}),
			timeoutMs,
		);
		const reply = (value: ClaudeCodeCallReply) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			const index = entry.queue.indexOf(call);
			if (index >= 0) entry.queue.splice(index, 1);
			resolve(value);
		};
		const call: ClaudeCodeCall = { name, args, reply };
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

export async function mcpToolDefinitions(
	tools: ToolSet,
): Promise<McpToolDefinition[]> {
	return Promise.all(
		Object.entries(tools)
			.filter(([, definition]) => typeof definition.execute === "function")
			.map(async ([name, definition]) => ({
				name,
				description:
					typeof definition.description === "string"
						? definition.description
						: name,
				inputSchema: (await asSchema(definition.inputSchema)
					.jsonSchema) as Record<string, unknown>,
			})),
	);
}

function outputText(output: unknown) {
	if (typeof output === "string") return output;
	try {
		return JSON.stringify(output) ?? "";
	} catch {
		return String(output);
	}
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
	const id = `ccmcp-${Date.now().toString(36)}-${entry.calls}`;
	try {
		await context.onEvent({
			type: "tool-call",
			id,
			name: call.name,
			input: call.args,
		});
		const validate = asSchema(definition.inputSchema).validate;
		const parsed = validate ? await validate(call.args) : undefined;
		if (parsed && !parsed.success)
			throw new Error(
				`Invalid arguments for ${call.name}: ${parsed.error.message}`,
			);
		const output = await (definition.execute as NonNullable<Tool["execute"]>)(
			parsed?.success ? parsed.value : call.args,
			{
				toolCallId: id,
				messages: [],
				abortSignal: context.signal,
				context: {},
			} as ExecuteOptions,
		);
		if (output && typeof output === "object" && Symbol.asyncIterator in output)
			throw new Error(`${call.name} streams and cannot run here.`);
		const failed =
			(output as { blocked?: unknown } | null | undefined)?.blocked === true;
		await context.onEvent({
			type: "tool-result",
			id,
			name: call.name,
			output,
			...(failed ? { failed: true } : {}),
		});
		call.reply({ text: outputText(output), isError: failed });
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
