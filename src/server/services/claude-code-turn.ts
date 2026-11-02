import type { ModelMessage, ToolSet } from "ai";
import { PLAN_TOOL } from "#/domain/agent-todos";
import type { ApiAgentEvent } from "#/domain/api-agent-event";
import { ClaudeCodeRunFailure } from "#/domain/api-turn-failure";
import type { ClaudeCodePlanStep } from "#/domain/claude-code-stream";
import { CODE_MODE_TOOL } from "#/domain/code-mode";
import type { WorkspaceId } from "#/domain/ids";
import { isReaderRole, type SubagentRole } from "#/domain/subagent";
import {
	downloadCheckpoint,
	uploadCheckpoint,
} from "../adapters/checkpoints/storage";
import {
	claudeSubscriptionStatus,
	claudeSubscriptionTokenForRedaction,
	readClaudeCodeSession,
	saveClaudeCodeSession,
} from "../adapters/claude-subscription";
import { gitProxyConfiguration } from "../adapters/github/git-proxy-transfer";
import type { AgentToolWorkspace } from "./agent-tool-workspace";
import {
	closeClaudeCodeBridge,
	mcpToolDefinitions,
	pendingClaudeCodeCalls,
	publishClaudeCodeTools,
	runClaudeCodeCall,
	takeClaudeCodeCalls,
	waitForClaudeCodeCall,
} from "./claude-code-bridge";
import {
	type ClaudeCodeStepResult,
	runClaudeCodeStep,
	stopClaudeCodeRun,
} from "./claude-code-runner";
import type { WorkspaceMachines } from "./workspace-machines";

/** Tools Claude Code has its own of; everything else of the turn's is offered over MCP. */
export function claudeCodeBridgeToolSet(
	tools: ToolSet,
	own: readonly string[],
): ToolSet {
	const skipped = new Set([...own, CODE_MODE_TOOL, PLAN_TOOL]);
	return Object.fromEntries(
		Object.entries(tools).filter(([name]) => !skipped.has(name)),
	);
}

/**
 * One durable step of a Claude Code turn, with the turn's context: its
 * chat's machine, its tools (offered to the CLI over MCP), its timeline.
 */
export async function runClaudeCodeTurnStep(input: {
	readonly userId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly modelId: string;
	readonly agentRole: SubagentRole | null | undefined;
	readonly workspace: () => Promise<AgentToolWorkspace>;
	/** The machines before the session's scoping, to run as the default user. */
	readonly machines: WorkspaceMachines;
	readonly messages: readonly ModelMessage[];
	readonly tools: ToolSet;
	readonly deadline: number;
	readonly signal: AbortSignal;
	readonly redact: () => readonly string[];
	readonly addRedaction: (value: string) => void;
	readonly hasItem: (id: string) => boolean;
	readonly toolName: (id: string) => string | undefined;
	readonly onEvent: (event: ApiAgentEvent) => Promise<void>;
	readonly onPlan: (plan: readonly ClaudeCodePlanStep[]) => void;
}): Promise<ClaudeCodeStepResult> {
	const edge = gitProxyConfiguration();
	if (!edge)
		throw new ClaudeCodeRunFailure(
			"this deployment has no edge address for the machine to reach.",
		);
	// Safety net: the real token is redacted from anything the turn shows.
	const token = await claudeSubscriptionTokenForRedaction(input.userId).catch(
		() => null,
	);
	if (token) input.addRedaction(token);
	const ready = await input.workspace();
	const vm = ready.vm;
	const { machines } = input;
	publishClaudeCodeTools(input.turnId, await mcpToolDefinitions(input.tools));
	const running = new Set<Promise<void>>();
	const reader = isReaderRole(input.agentRole);
	let ended = true;
	try {
		const result = await runClaudeCodeStep({
			shell: async (command, timeoutMs) => {
				const result = await machines.exec(vm, command, timeoutMs);
				return {
					exitCode: result.exitCode,
					stdout: result.stdout,
					stderr: result.stderr,
				};
			},
			writeFile: (path, contents) => machines.writeTextFile(vm, path, contents),
			readFile: (path) => machines.readTextFile(vm, path),
			cwd: ready.cwd,
			userId: input.userId,
			sessionId: input.sessionId,
			turnId: input.turnId,
			modelId: input.modelId,
			messages: input.messages,
			edgeOrigin: edge.origin,
			grantSecret: edge.secret,
			reader,
			// The session's reader machines isolate the reader on first use.
			prepareReader: async () => {
				await ready.machines.exec(ready.vm, "true", 30_000);
			},
			deadline: input.deadline,
			signal: input.signal,
			redact: input.redact,
			addRedaction: input.addRedaction,
			hasItem: input.hasItem,
			toolName: input.toolName,
			onEvent: input.onEvent,
			onPlan: input.onPlan,
			bridge: {
				pump: () => {
					for (const call of takeClaudeCodeCalls(input.turnId)) {
						const run = runClaudeCodeCall(input.turnId, call, {
							tools: input.tools,
							onEvent: input.onEvent,
							signal: input.signal,
						}).finally(() => running.delete(run));
						running.add(run);
					}
				},
				busy: () =>
					running.size > 0 || pendingClaudeCodeCalls(input.turnId) > 0,
				wait: (ms) => waitForClaudeCodeCall(input.turnId, ms),
			},
			store: {
				readSession: () => readClaudeCodeSession(input.userId, input.sessionId),
				saveSession: (record) =>
					saveClaudeCodeSession(input.userId, input.sessionId, record),
				uploadTranscript: (claudeSessionId, text) =>
					uploadCheckpoint(
						input.userId,
						input.sessionId,
						`claude-code-${claudeSessionId}`,
						text,
					),
				downloadTranscript: (path) =>
					downloadCheckpoint(input.userId, input.sessionId, path),
				subscriptionStatus: () => claudeSubscriptionStatus(input.userId),
			},
		});
		ended = result.outcome === "completed";
		return result;
	} finally {
		// A call still answering keeps its own context; it settles on its own.
		await Promise.race([
			Promise.allSettled(running),
			new Promise((resolve) => setTimeout(resolve, 5_000)),
		]);
		if (ended) closeClaudeCodeBridge(input.turnId);
	}
}

/**
 * Stops the turn's Claude Code CLI on the chat's machine once the turn moved
 * to another model, so its trailing output is never read. Never throws.
 */
export async function stopClaudeCodeTurnRun(input: {
	readonly machines: WorkspaceMachines;
	readonly vm: WorkspaceId | null;
	readonly turnId: string;
}): Promise<void> {
	const { vm } = input;
	if (!vm) return;
	await stopClaudeCodeRun(async (command, timeoutMs) => {
		const result = await input.machines.exec(vm, command, timeoutMs);
		return {
			exitCode: result.exitCode,
			stdout: result.stdout,
			stderr: result.stderr,
		};
	}, input.turnId).catch((error: unknown) =>
		console.warn("Claude Code could not be stopped after a failover.", {
			message: error instanceof Error ? error.message.slice(0, 200) : "unknown",
		}),
	);
}
