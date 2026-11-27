import type { ModelMessage, ToolSet } from "ai";
import type { ApiAgentEvent } from "#/domain/api-agent-event";
import {
	ClaudeCodeRunFailure,
	ClaudeRunnerRequired,
} from "#/domain/api-turn-failure";
import type { ClaudeCodePlanStep } from "#/domain/claude-code-stream";
import {
	CLAUDE_RUNNER_FULL_SHARE,
	CLAUDE_RUNNER_WORKDIR,
	type ClaudeRunnerBox,
	claudeRunnerSessionWorkdir,
} from "#/domain/claude-runner";
import { CODE_MODE_TOOL } from "#/domain/code-mode";
import type { LeanToolShape } from "#/domain/harness-model-profile";
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
import {
	isCutConnection,
	isPlatformRestart,
} from "../adapters/freestyle/provider-retry";
import { gitProxyConfiguration } from "../adapters/github/git-proxy-transfer";
import type { AgentToolWorkspace } from "./agent-tool-workspace";
import {
	type BoxToolIdentityStore,
	grantClaudeBoxTools,
	releaseClaudeBoxToolIdentity,
} from "./claude-box-tool-grant";
import { claudeBoxToolsBundle } from "./claude-box-tools-bundle";
import {
	CLAUDE_CODE_INBOX_CALL,
	closeClaudeCodeBridge,
	mcpToolDefinitions,
	onClaudeCodeCallQueued,
	pendingClaudeCodeCalls,
	publishClaudeCodeTools,
	requestClaudeCodeCall,
	runClaudeCodeCall,
	takeClaudeCodeCalls,
	waitForClaudeCodeCall,
} from "./claude-code-bridge";
import {
	type ClaudeCodeShell,
	type ClaudeCodeStepResult,
	type ClaudeCodeStore,
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
import { ensureLeanHelpers } from "./lean-helpers";
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
 * The VM each turn's current box tool grant was minted for, in this isolate
 * (a restarted one does not know, and treats a replaced VM's grant as stale).
 */
const boxToolGrantVms = new Map<string, string>();

/**
 * One durable step of a Claude Code turn, with the turn's context: its
 * chat's machine, its tools (offered to the CLI over MCP), its timeline.
 */
/** The machine a Claude runner box is, as the step drives it. */
export type ClaudeRunnerHostMachine = {
	readonly shell: ClaudeCodeShell;
	readonly writeFile: (path: string, contents: string) => Promise<void>;
	readonly readFile: (path: string) => Promise<string | null>;
};

/**
 * A step running on a turn runner box (docs/turn-runner-boxes.md, "Claude
 * Code on a box"): the edge signs for the runner, mints the grant and keeps
 * the chat's Claude session; the run's MCP calls come relayed over the box's
 * socket (claude-relay.ts). Absent: the step runs in the chat's object.
 */
export type ClaudeCodeTurnHost = {
	readonly edgeOrigin: string;
	readonly machine: (runner: ClaudeRunnerBox) => ClaudeRunnerHostMachine;
	readonly diskShare: (runner: ClaudeRunnerBox) => Promise<number | null>;
	readonly issueGrant: () => Promise<string>;
	readonly store: Omit<ClaudeCodeStore, "direct">;
	/** Relayed calls go to `handler` until the returned function runs. */
	readonly relay: (
		handler: (call: {
			readonly name: string;
			readonly args: Record<string, unknown>;
			readonly invocationId?: string;
			readonly timeoutMs: number;
			readonly graceMs: number;
		}) => Promise<{ text: string; isError: boolean }>,
	) => () => void;
	readonly publishTools: (definitions: readonly unknown[]) => void;
};

/** A waiting poll's longest wait on a turn box (each poll is a request through the edge). */
const HOSTED_POLL_WAIT_MS = 20_000;

export async function runClaudeCodeTurnStep(input: {
	readonly userId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly modelId: string;
	/** The reasoning effort the user chose; the model's own default when absent. */
	readonly effort?: string;
	readonly agentRole: SubagentRole | null | undefined;
	/** The pull request the platform opened for this chat (pullRequestNote). */
	readonly pullRequestNote?: string;
	/** Set when the step runs on a turn runner box. */
	readonly host?: ClaudeCodeTurnHost;
	/**
	 * The chat's machine; absent only for Y² (`ySquared`), which has none and
	 * so runs on a runner box alone.
	 */
	readonly workspace?: () => Promise<AgentToolWorkspace>;
	/** The machines before the session's scoping, to run as the default user. */
	readonly machines?: WorkspaceMachines;
	/**
	 * Y²: no machine, only ytimesy's tools, this system prompt. Needs `runner`
	 * (a missing one is ClaudeRunnerRequired); the run's working directory is
	 * its own on the box.
	 */
	readonly ySquared?: { readonly instructions: string };
	/** The compact secret-names line for the CLI's system prompt (never values). */
	readonly secretsLine?: string;
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
		/**
		 * The lean workspace tools the box runs itself against the chat's VM
		 * (YTIMESY_CLAUDE_BOX_TOOLS, claude-box-tools/); absent: all on the edge.
		 */
		readonly boxTools?: {
			readonly tools: readonly string[];
			readonly shape: LeanToolShape;
			readonly redact: () => readonly string[];
			/**
			 * The turn has runtime secrets: the box is granted only when the VM
			 * can redact them itself (vm-secret-redaction.ts).
			 */
			readonly redactOnVm: boolean;
			/**
			 * Checked before each grant: false (repository tool hooks, say)
			 * keeps the run's tools on the edge.
			 */
			readonly eligible: () => Promise<boolean>;
			/** The turn's identity record (api_turn.box_tool_identity). */
			readonly store: BoxToolIdentityStore;
		};
	};
}): Promise<ClaudeCodeStepResult> {
	const { workspace, machines, ySquared, host } = input;
	// No machine: only a runner box can host the CLI, and only Y² has none.
	if (!workspace && !input.runner) throw new ClaudeRunnerRequired();
	if (!workspace && !ySquared)
		throw new Error("A Claude Code turn without a workspace must be Y².");
	const edge: { origin: string; secret?: string } | null = host
		? { origin: host.edgeOrigin }
		: gitProxyConfiguration();
	if (!edge)
		throw new ClaudeCodeRunFailure(
			"this deployment has no edge address for the machine to reach.",
		);
	// Safety net: the real token is redacted from anything the turn shows. Read
	// while the machine is prepared, not before it.
	// A box never holds the token, so it has nothing to redact.
	const redactingToken = host
		? Promise.resolve()
		: claudeSubscriptionTokenForRedaction(input.userId)
				.catch(() => null)
				.then((token) => {
					if (token) input.addRedaction(token);
				});
	const [ready, definitions] = await Promise.all([
		workspace?.() ?? Promise.resolve(null),
		mcpToolDefinitions(input.tools),
		redactingToken,
	]);
	const vm = ready?.vm ?? null;
	// Without a machine the CLI runs in its own directory on the box.
	const cwd = ready
		? input.runner
			? CLAUDE_RUNNER_WORKDIR
			: ready.cwd
		: claudeRunnerSessionWorkdir(input.sessionId);
	const vmHost = () => {
		if (!ready || !machines)
			throw new Error("This turn has no workspace machine.");
		return { ready, machines };
	};
	const box = input.runner
		? (host?.machine ?? claudeRunnerMachine)(input.runner.box)
		: null;
	// Box tools need the chat object's VM grants: never from a turn box.
	const boxTools = host ? undefined : input.runner?.boxTools;
	// The chat's VM was replaced: the identity names the lost one. Deleting it
	// sends a running box's calls to the edge, which uses the new VM. One
	// minted for this VM (a later step of the turn) is kept; unknown is deleted.
	if (
		boxTools &&
		ready &&
		machines &&
		ready.replacedFrom !== undefined &&
		boxToolGrantVms.get(input.turnId) !== vm
	) {
		boxToolGrantVms.delete(input.turnId);
		await releaseClaudeBoxToolIdentity({ machines, store: boxTools.store });
	}
	publishClaudeCodeTools(input.turnId, definitions);
	host?.publishTools(definitions);
	const direct = host
		? null
		: directTranscriptStore(input.userId, input.sessionId);
	const directTranscript = direct ? { direct } : {};
	const running = new Set<Promise<void>>();
	let timedCalls = 0;
	const reader = isReaderRole(input.agentRole);
	let ended = true;
	const feed = host ? undefined : claudeTurnFeed(input.turnId);
	// The chat's object previews the run's text between steps, redacted alike.
	if (feed) rememberClaudeTurnRedaction(input.turnId, input.redact);
	const pump = () => {
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
	};
	// On a box the run's calls come over its socket: each is queued here as
	// the chat's object would, and taken at once (the step's polls wait long).
	const stopRelay = host
		? (() => {
				const unqueued = onClaudeCodeCallQueued(input.turnId, pump);
				const unrelayed = host.relay((call) =>
					requestClaudeCodeCall(
						input.turnId,
						call.name,
						call.args,
						call.timeoutMs,
						call.graceMs,
						call.invocationId,
					),
				);
				return () => {
					unqueued();
					unrelayed();
				};
			})()
		: () => {};
	try {
		const result = await runClaudeCodeStep({
			...(feed ? { feed } : {}),
			...(input.pullRequestNote
				? { pullRequestNote: input.pullRequestNote }
				: {}),
			mayPause: () => claudeTurnMayPause(input.turnId),
			mayPauseOnFeed: () => claudeFeedStepMayPause(input.turnId),
			requestPause: (ms) => requestClaudeStepPause(input.turnId, ms),
			requestPark: () => requestClaudeStepPark(input.turnId),
			shell:
				box?.shell ??
				(async (command, timeoutMs) => {
					const host = vmHost();
					const result = await host.machines.exec(
						host.ready.vm,
						command,
						timeoutMs,
					);
					return {
						exitCode: result.exitCode,
						stdout: result.stdout,
						stderr: result.stderr,
					};
				}),
			writeFile:
				box?.writeFile ??
				((path, contents) => {
					const host = vmHost();
					return host.machines.writeTextFile(host.ready.vm, path, contents);
				}),
			readFile:
				box?.readFile ??
				((path) => {
					const host = vmHost();
					return host.machines.readTextFile(host.ready.vm, path);
				}),
			cwd,
			...(input.runner
				? {
						beforeLaunch: async () => {
							const share = await (host?.diskShare ?? claudeRunnerDiskShare)(
								(input.runner as { box: ClaudeRunnerBox }).box,
							);
							if (share !== null && share >= CLAUDE_RUNNER_FULL_SHARE)
								throw new ClaudeCodeRunFailure(
									"its runner is full (the disk is almost out of space), so it did not start.",
								);
							// Its own directory: Claude keys the session file by it.
							if (!ready) {
								const made = await (box as NonNullable<typeof box>).shell(
									`mkdir -p -- '${cwd}'`,
									30_000,
								);
								if (made.exitCode !== 0)
									throw new ClaudeCodeRunFailure(
										"its runner could not create the chat's working directory.",
									);
							}
						},
					}
				: {}),
			...(input.runner
				? {
						remote: {
							repository: ready?.cwd ?? cwd,
							workspaceTools: input.runner.workspaceTools,
						},
					}
				: {}),
			// The prompt names the tools really offered over MCP.
			...(ySquared
				? { ySquared: { ...ySquared, tools: Object.keys(input.tools) } }
				: {}),
			...(input.secretsLine ? { secretsLine: input.secretsLine } : {}),
			...(boxTools && ready && machines
				? {
						boxTools: {
							tools: boxTools.tools,
							shape: boxTools.shape,
							redact: boxTools.redact,
							grant: async () => {
								if (!(await boxTools.eligible())) return null;
								const grant = await grantClaudeBoxTools({
									machines,
									vm: ready.vm,
									store: boxTools.store,
									redactOnVm: boxTools.redactOnVm,
								});
								if (grant) {
									boxToolGrantVms.set(input.turnId, grant.vmId);
									// The box serves the lean tools itself: their helper
									// commands go on the VM now, as the edge's tools would.
									await ensureLeanHelpers(
										{ machines, vm: ready.vm },
										input.sessionId,
									).catch(() => undefined);
								}
								return grant;
							},
							bundle: claudeBoxToolsBundle,
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
			...(edge.secret ? { grantSecret: edge.secret } : {}),
			...(host
				? { issueGrant: host.issueGrant, pollWaitMs: HOSTED_POLL_WAIT_MS }
				: {}),
			reader,
			// The session's reader machines isolate the reader on first use.
			...(ready
				? {
						prepareReader: async () => {
							await ready.machines.exec(ready.vm, "true", 30_000);
						},
					}
				: {}),
			deadline: input.deadline,
			signal: input.signal,
			redact: input.redact,
			addRedaction: input.addRedaction,
			hasItem: input.hasItem,
			toolName: input.toolName,
			onEvent: input.onEvent,
			onPlan: input.onPlan,
			bridge: {
				pump,
				busy: () =>
					running.size > 0 || pendingClaudeCodeCalls(input.turnId) > 0,
				wait: (ms) => waitForClaudeCodeCall(input.turnId, ms),
			},
			store: host?.store ?? {
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
		stopRelay();
		// A call still answering keeps its own context; it settles on its own.
		await Promise.race([
			Promise.allSettled(running),
			new Promise((resolve) => setTimeout(resolve, 5_000)),
		]);
		if (ended) {
			closeClaudeCodeBridge(input.turnId);
			boxToolGrantVms.delete(input.turnId);
		}
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
	// A connection a deploy cut (isCutConnection) resumes the step too: the
	// run must still be there to re-attach to (2026-11-23: a Claude turn
	// failed on "Network connection lost." a second before its object reset).
	return reasons.some(
		(reason) => isPlatformRestart(reason) || isCutConnection(reason),
	);
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
	/** A turn box's way to the runner (through the edge). */
	readonly machine?: (runner: ClaudeRunnerBox) => ClaudeRunnerHostMachine;
}): Promise<void> {
	const { vm } = input;
	const box = input.runner
		? (input.machine ?? claudeRunnerMachine)(input.runner)
		: null;
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
