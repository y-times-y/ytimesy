import type { ModelMessage, ToolSet } from "ai";
import type { ApiAgentEvent } from "#/domain/api-agent-event";
import { ClaudeCodeRunFailure } from "#/domain/api-turn-failure";
import type { ClaudeCodePlanStep } from "#/domain/claude-code-stream";
import {
	CLAUDE_RUNNER_FULL_SHARE,
	CLAUDE_RUNNER_WORKDIR,
	type ClaudeRunnerBox,
} from "#/domain/claude-runner";
import { CODE_MODE_TOOL } from "#/domain/code-mode";
import type { WorkspaceId } from "#/domain/ids";
import { isReaderRole, type SubagentRole } from "#/domain/subagent";
import { directTranscriptStore } from "../adapters/checkpoints/direct-transcript";
import {
	downloadCheckpoint,
	uploadCheckpoint,
} from "../adapters/checkpoints/storage";
import {
	claudeRunnerDiskShare,
	claudeRunnerMachine,
} from "../adapters/claude-runner-box";
import {
	claudeSubscriptionStatus,
	claudeSubscriptionTokenForRedaction,
	readClaudeCodeSession,
	saveClaudeCodeSession,
} from "../adapters/claude-subscription";
import { isPlatformRestart } from "../adapters/freestyle/provider-retry";
import { gitProxyConfiguration } from "../adapters/github/git-proxy-transfer";
import type { AgentToolWorkspace } from "./agent-tool-workspace";
import {
	CLAUDE_CODE_INBOX_CALL,
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
import {
	claudeFeedStepMayPause,
	claudeTurnFeed,
	claudeTurnMayPause,
	rememberClaudeTurnRedaction,
	requestClaudeStepPark,
	requestClaudeStepPause,
} from "./claude-step-pause";
import type { WorkspaceMachines } from "./workspace-machines";

/** Native web tools stay local; workspace work uses the tracked MCP tool lifecycle on either host. */
export function claudeCodeBridgeToolSet(
	tools: ToolSet,
	own: readonly string[],
	/** Kept explicit for callers that intentionally restrict a helper's tool set. */
	offerCodeMode = true,
): ToolSet {
	const skipped = new Set([...own, ...(offerCodeMode ? [] : [CODE_MODE_TOOL])]);
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
	/** The reasoning effort the user chose; the model's own default when absent. */
	readonly effort?: string;
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
	/**
	 * Takes the messages the user sent (Send on a queued message) since the
	 * run started and returns what the model reads for them; empty for none.
	 * The run's hooks ask after each tool call and before it would end.
	 */
	readonly inbox?: () => Promise<string>;
	/** Timing only: each bridged tool call's start and end (turn-tool-time.ts). */
	readonly toolTime?: {
		start(id: string, tool: string): void;
		end(id: string): void;
	};
	/**
	 * Run `claude` on this runner box instead of the chat's machine; the
	 * chat's machine stays the workspace, reached through `workspaceTools`.
	 */
	readonly runner?: {
		readonly box: ClaudeRunnerBox;
		readonly workspaceTools: readonly string[];
	};
}): Promise<ClaudeCodeStepResult> {
	const edge = gitProxyConfiguration();
	if (!edge)
		throw new ClaudeCodeRunFailure(
			"this deployment has no edge address for the machine to reach.",
		);
	// Safety net: the real token is redacted from anything the turn shows. Read
	// while the machine is prepared, not before it.
	const redactingToken = claudeSubscriptionTokenForRedaction(input.userId)
		.catch(() => null)
		.then((token) => {
			if (token) input.addRedaction(token);
		});
	const [ready, definitions] = await Promise.all([
		input.workspace(),
		mcpToolDefinitions(input.tools),
		redactingToken,
	]);
	const vm = ready.vm;
	const { machines } = input;
	const box = input.runner ? claudeRunnerMachine(input.runner.box) : null;
	publishClaudeCodeTools(input.turnId, definitions);
	const direct = directTranscriptStore(input.userId, input.sessionId);
	const directTranscript = direct ? { direct } : {};
	const running = new Set<Promise<void>>();
	let timedCalls = 0;
	const reader = isReaderRole(input.agentRole);
	let ended = true;
	const feed = claudeTurnFeed(input.turnId);
	// The chat's object previews the run's text between steps, redacted alike.
	if (feed) rememberClaudeTurnRedaction(input.turnId, input.redact);
	try {
		const result = await runClaudeCodeStep({
			...(feed ? { feed } : {}),
			mayPause: () => claudeTurnMayPause(input.turnId),
			mayPauseOnFeed: () => claudeFeedStepMayPause(input.turnId),
			requestPause: (ms) => requestClaudeStepPause(input.turnId, ms),
			requestPark: () => requestClaudeStepPark(input.turnId),
			shell:
				box?.shell ??
				(async (command, timeoutMs) => {
					const result = await machines.exec(vm, command, timeoutMs);
					return {
						exitCode: result.exitCode,
						stdout: result.stdout,
						stderr: result.stderr,
					};
				}),
			writeFile:
				box?.writeFile ??
				((path, contents) => machines.writeTextFile(vm, path, contents)),
			readFile: box?.readFile ?? ((path) => machines.readTextFile(vm, path)),
			cwd: input.runner ? CLAUDE_RUNNER_WORKDIR : ready.cwd,
			...(input.runner
				? {
						beforeLaunch: async () => {
							const share = await claudeRunnerDiskShare(
								(input.runner as { box: ClaudeRunnerBox }).box,
							);
							if (share !== null && share >= CLAUDE_RUNNER_FULL_SHARE)
								throw new ClaudeCodeRunFailure(
									"its runner is full (the disk is almost out of space), so it did not start.",
								);
						},
					}
				: {}),
			...(input.runner
				? {
						remote: {
							repository: ready.cwd,
							workspaceTools: input.runner.workspaceTools,
						},
					}
				: {}),
			userId: input.userId,
			sessionId: input.sessionId,
			turnId: input.turnId,
			modelId: input.modelId,
			...(input.effort ? { effort: input.effort } : {}),
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
						if (call.name === CLAUDE_CODE_INBOX_CALL) {
							const run = (input.inbox?.() ?? Promise.resolve(""))
								.then(
									(text) => call.reply({ text, isError: false }),
									() => call.reply({ text: "", isError: false }),
								)
								.finally(() => running.delete(run));
							running.add(run);
							continue;
						}
						const timingId = `cc-${++timedCalls}`;
						input.toolTime?.start(timingId, call.name);
						const run = runClaudeCodeCall(input.turnId, call, {
							tools: input.tools,
							onEvent: input.onEvent,
							signal: input.signal,
						}).finally(() => {
							running.delete(run);
							input.toolTime?.end(timingId);
						});
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
				// Transcripts above the inline limit go from the VM straight to R2.
				...directTranscript,
				subscriptionStatus: () => claudeSubscriptionStatus(input.userId),
			},
		});
		ended = result.outcome === "completed";
		return result;
	} catch (error) {
		// The detached agent and waiting MCP calls belong to the turn, not this
		// interrupted step. Do not answer "turn ended" when it will reattach.
		if (leavesClaudeCodeRunning([error, input.signal.reason])) ended = false;
		throw error;
	} finally {
		// A call still answering keeps its own context; it settles on its own.
		await Promise.race([
			Promise.allSettled(running),
			new Promise((resolve) => setTimeout(resolve, 5_000)),
		]);
		if (ended) closeClaudeCodeBridge(input.turnId);
	}
}

/** What the run's model reads for messages the user sent while it worked. */
export function claudeCodeSentMessagesText(sent: readonly ModelMessage[]) {
	const texts = sent
		.map((message) =>
			typeof message.content === "string" ? message.content.trim() : "",
		)
		.filter(Boolean);
	if (!texts.length) return "";
	return `The user sent ${texts.length === 1 ? "this message" : "these messages"} while you were working. Read ${texts.length === 1 ? "it" : "them"} now and take ${texts.length === 1 ? "it" : "them"} into account before you continue; where ${texts.length === 1 ? "it conflicts" : "they conflict"} with your current plan, the user's message wins.\n\n${texts.join("\n\n---\n\n")}`;
}

/**
 * The turn's history after a Claude Code step: messages its hooks delivered
 * mid-run go before the run's answer (they were part of that run), so the
 * next run's prompt (the user messages after the last answer) leaves them out.
 */
export function withMessagesSentDuringRun(
	messages: readonly ModelMessage[],
	sent: readonly ModelMessage[],
): ModelMessage[] {
	if (!sent.length) return [...messages];
	const last = messages.at(-1);
	return last?.role === "assistant"
		? [...messages.slice(0, -1), ...sent, last]
		: [...messages, ...sent];
}

/**
 * Whether an abort that stops the turn's commands should leave its Claude
 * Code run alone. The agent loop of a Claude Code turn is the `claude`
 * process itself, so stopping it for a deploy (a Durable Object reset for new
 * code) loses the whole turn, where a step that only called a model resumes
 * from its checkpoint. A platform restart resumes the step, which re-attaches
 * to the process; a user's Stop and the turn's deadline still stop it.
 */
export function leavesClaudeCodeRunning(reasons: readonly unknown[]) {
	return reasons.some((reason) => isPlatformRestart(reason));
}

/**
 * Stops the turn's Claude Code run on the chat's machine once the turn moved
 * to another model, so its trailing output is never read. Never throws.
 */
export async function stopClaudeCodeTurnRun(input: {
	readonly machines: WorkspaceMachines;
	readonly vm: WorkspaceId | null;
	readonly turnId: string;
	readonly runner?: ClaudeRunnerBox | null;
}): Promise<void> {
	const { vm } = input;
	const box = input.runner ? claudeRunnerMachine(input.runner) : null;
	if (!vm && !box) return;
	await stopClaudeCodeRun(async (command, timeoutMs) => {
		if (box) return box.shell(command, timeoutMs);
		if (!vm) throw new Error("The workspace machine is unavailable.");
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
