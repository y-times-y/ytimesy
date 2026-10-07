import { createHash } from "node:crypto";
import { Effect } from "effect";
import { cloudAgentRoleInstructions } from "#/domain/agent-orchestration";
import { assertApiContextFits } from "#/domain/api-conversation";
import { applyApiProgress, recordedContextUsage } from "#/domain/api-progress";
import { addApiTokenUsage } from "#/domain/api-token-usage";
import {
	type ApiTurnFailureStage,
	apiTurnFailureClassification,
	apiTurnFailureMessage,
	IncompleteAgentTurn,
} from "#/domain/api-turn-failure";
import { PREPARED_ENVIRONMENT_INSTRUCTIONS } from "#/domain/environment-context";
import { SessionItemId, WorkspaceId } from "#/domain/ids";
import { posixShellCommand } from "#/domain/posix-command";
import { PROJECT_KNOWLEDGE_INSTRUCTIONS } from "#/domain/project-knowledge";
import { subscriptionTurnSettings } from "#/domain/subscription-turn";
import {
	completedChildrenForReview,
	withDelegationContext,
} from "../adapters/agent-delegation-context";
import { agentSessionForOwner } from "../adapters/agent-sessions";
import { saveAgentTaskResultAndEvent } from "../adapters/agent-task-events";
import { captureServerAnalytics } from "../adapters/analytics";
import {
	type ApiTurn,
	checkpointApiTurn,
	finalizeApiTurn,
	publishApiTurnProgress,
	renewApiTurn,
} from "../adapters/api-turns";
import { reserveApiTokens } from "../adapters/api-usage-budget";
import { archiveModelContext } from "../adapters/context-archives";
import { coordinateConversationTurn } from "../adapters/conversation-turn-control";
import {
	assertEvaluationActive,
	type EvaluationRun,
	evaluationRunForTask,
	recordEvaluationUsage,
	reserveEvaluationRequest,
} from "../adapters/harness-evaluation";
import { loadModelConnection } from "../adapters/model-connections";
import { injectServerPeerMessages } from "../adapters/server-peer-inbox";
import { hasManagedCodexAuth } from "../auth/codex-managed-auth";
import { discoveredToolsFromSession } from "../services/agent-tool-discovery";
import type { AgentToolWorkspace } from "../services/agent-tool-workspace";
import { runApiAgent, runApiAgentStep } from "../services/api-agent-runtime";
import { apiAgentTools } from "../services/api-agent-tools";
import { stopApiTurnCommands } from "../services/api-command-scope";
import { deferredApiTurnWorkspace } from "../services/api-turn-workspace";
import {
	pendingAgentCommandIds,
	withBackgroundCommandContext,
} from "../services/background-command-context";
import {
	runCodexSubscriptionAgent,
	runCodexSubscriptionAgentStep,
} from "../services/codex-subscription-agent";
import { withCompletedTaskReviewContext } from "../services/completed-task-review-context";
import { runAgentTaskTool } from "../services/harness-workspace-session";
import {
	loadCloudProjectKnowledge,
	recordCloudProjectReport,
} from "../services/project-knowledge";
import { machinesForAgentSession } from "../services/session-workspace-machines";
import { analyticsAgentRole } from "../services/turn-analytics";
import { commitCompletedSessionTurn } from "../services/turn-commit";
import { turnProgressWriter } from "../services/turn-progress-writer";
import type { WorkspaceMachines } from "../services/workspace-machines";
import { enqueueAgentTaskEvent } from "./queue";

export type ApiTurnStepOutcome =
	| "continue"
	| "completed"
	| "failed"
	| "cancelled";

/** Step mode is for the external durable orchestrator; the default preserves the local worker. */
export async function runApiTurn(
	machines: WorkspaceMachines,
	turn: ApiTurn,
	step?: { index: number; signal: AbortSignal; limitReached?: boolean },
): Promise<ApiTurnStepOutcome> {
	const abort = new AbortController();
	const stopForDeadline = () =>
		abort.abort(new Error("Durable turn deadline reached."));
	step?.signal.addEventListener("abort", stopForDeadline, { once: true });
	if (step?.signal.aborted) stopForDeadline();
	let items = turn.items;
	const previousUsage = step
		? [...items].reverse().find((item) => item.kind === "userMessage")
		: undefined;
	let messages = turn.messages;
	let execution: AgentToolWorkspace | undefined;
	let commandStop: Promise<void> | undefined;
	const stopCommands = () => {
		if (execution)
			commandStop ??= stopApiTurnCommands(execution, turn.id).catch(() => {
				console.warn(
					"Command cancellation needs recovery; turn fencing remains active.",
				);
			});
	};
	abort.signal.addEventListener("abort", stopCommands, { once: true });
	let publishProgress:
		| ((status: "running" | "completed" | "failed" | "idle") => Promise<void>)
		| undefined;
	let heartbeatBusy = false;
	let heartbeatPending: Promise<void> | undefined;
	let coordinationHeartbeatPending: Promise<void> | undefined;
	let coordinationHeartbeatBusy = false;
	let heartbeatFailed = false;
	let progressFailed = false;
	const progress = turnProgressWriter(
		(snapshot) => publishApiTurnProgress(turn, snapshot),
		() => {
			progressFailed = true;
			abort.abort(new Error("Turn progress could not be saved."));
		},
	);
	const saveCheckpoint = async () => {
		await progress.drain();
		await checkpointApiTurn(turn, messages, items);
	};
	let failureStage: ApiTurnFailureStage = "connection";
	const control = {
		userId: turn.user_id,
		sessionId: turn.session_id,
		turnId: turn.id,
		leaseId: turn.lease_id as string,
	};
	let coordinated = false;
	let lastCoordinationRenewal = 0;
	let evaluation: EvaluationRun | null = null;
	const heartbeat = setInterval(() => {
		const guardHeartbeat = (stage: string, operation: Promise<void>) =>
			operation.catch((error: unknown) => {
				heartbeatFailed = true;
				console.warn("Turn heartbeat failed", {
					stage,
					...apiTurnFailureClassification(error),
				});
				abort.abort(
					new Error(
						"Turn heartbeat or coordination service became unavailable.",
					),
				);
			});
		if (
			coordinated &&
			!coordinationHeartbeatBusy &&
			!abort.signal.aborted &&
			Date.now() - lastCoordinationRenewal >= 10_000
		) {
			coordinationHeartbeatBusy = true;
			coordinationHeartbeatPending = guardHeartbeat(
				"coordination-renewal",
				coordinateConversationTurn("renew", control).then((alive) => {
					if (!alive)
						abort.abort(new Error("Conversation coordination lease was lost."));
					else lastCoordinationRenewal = Date.now();
				}),
			).finally(() => {
				coordinationHeartbeatBusy = false;
			});
		}
		if (heartbeatBusy || abort.signal.aborted) return;
		heartbeatBusy = true;
		const databaseHeartbeat = guardHeartbeat(
			"database-renewal",
			renewApiTurn(turn).then(async (alive) => {
				if (!alive)
					abort.abort(
						new Error("Turn ownership or cancellation state changed."),
					);
			}),
		);
		const evaluationHeartbeat = evaluation
			? guardHeartbeat("evaluation-guard", assertEvaluationActive(evaluation))
			: Promise.resolve();
		heartbeatPending = Promise.all([databaseHeartbeat, evaluationHeartbeat])
			.then(() => {})
			.finally(() => {
				heartbeatBusy = false;
			});
	}, 1000);
	try {
		failureStage = "coordination";
		if (
			!turn.lease_id ||
			!(await coordinateConversationTurn("acquire", control))
		)
			throw new Error("The conversation is already running or was stopped.");
		coordinated = true;
		failureStage = "connection";
		lastCoordinationRenewal = Date.now();
		if (!(await renewApiTurn(turn))) {
			abort.abort();
			abort.signal.throwIfAborted();
		}
		const owner = await agentSessionForOwner(turn.user_id, turn.session_id);
		if (!owner) throw new Error("Task no longer exists.");
		if (process.env.YTIMESY_HARNESS_EVALUATION_ENABLED === "1")
			evaluation = await evaluationRunForTask(owner.userId, owner.id);
		const subscription = subscriptionTurnSettings(turn.connection_revision);
		// The subscription endpoint rejects the public Responses apply_patch tool.
		// Writers retain the same V4A editor through its function-tool schema.
		let nativePatch = false;
		if (subscription) {
			if (turn.connection_id || !(await hasManagedCodexAuth(turn.user_id)))
				throw new Error("Reconnect Codex before continuing.");
		} else {
			if (!turn.connection_id) throw new Error("Model connection was removed.");
			const connection = await loadModelConnection(
				turn.user_id,
				turn.connection_id,
			);
			if (connection?.revision !== turn.connection_revision)
				throw new Error(
					"The API connection changed after this turn was submitted.",
				);
			nativePatch =
				connection.provider === "openai" &&
				connection.baseUrl.startsWith("https://api.openai.com/");
		}
		const prepareWorkspace = deferredApiTurnWorkspace(
			machines,
			owner,
			abort.signal,
		);
		const workspace = async () => {
			execution = await prepareWorkspace();
			return execution;
		};
		machines = machinesForAgentSession(machines, owner);
		publishProgress = async (turnStatus) => {
			if (turnStatus === "running") {
				progress.offer(items);
				await progress.drain();
			}
		};
		await publishProgress("running");
		const tools = apiAgentTools({
			machines,
			session: owner,
			workspace,
			turnId: turn.id,
			nativePatch,
			toolCallPrefix: step ? `step-${step.index}:` : undefined,
			signal: abort.signal,
		});
		const currentTask = [...items]
			.reverse()
			.find((item) => item.kind === "userMessage");
		const projectKnowledge = await loadCloudProjectKnowledge(
			owner,
			currentTask?.kind === "userMessage"
				? currentTask.text
				: (owner.taskPrompt ?? owner.title),
		);
		let flushedAt = 0;
		let metricIndex = 0;
		failureStage = "model";
		if (step?.limitReached) throw new IncompleteAgentTurn("tool-calls");
		const runAgent = subscription
			? step
				? runCodexSubscriptionAgentStep
				: runCodexSubscriptionAgent
			: (input: Parameters<typeof runCodexSubscriptionAgent>[0]) =>
					(step ? runApiAgentStep : runApiAgent)({
						...input,
						connectionId: turn.connection_id as string,
					});
		const previousContext = recordedContextUsage(items)?.context;
		const result = await runAgent({
			previousContext:
				previousContext?.modelContextWindow && previousContext.last.totalTokens
					? {
							tokens: previousContext.last.totalTokens,
							modelContextWindow: previousContext.modelContextWindow,
						}
					: undefined,
			cacheScopeId: owner.id,
			userId: turn.user_id,
			connectionId: turn.connection_id ?? undefined,
			connectionRevision: turn.connection_revision,
			reasoning: subscription?.reasoning,
			knownTools: discoveredToolsFromSession(items),
			toolSurface: owner.parentSessionId ? "implementation" : "coordination",
			onToolMetric: (metric) => {
				void captureServerAnalytics(
					owner.userId,
					"harness_tool_completed",
					{
						...metric,
						runtime: owner.harness,
						role: analyticsAgentRole(owner),
						model_key: createHash("sha256").update(turn.model_id).digest("hex"),
					},
					{
						key: `${turn.id}:${step?.index ?? 0}:tool-${metricIndex++}`,
						timestamp: new Date(),
					},
				);
			},
			onModelMetric: (metric) => {
				void captureServerAnalytics(
					owner.userId,
					"harness_model_completed",
					{
						...metric,
						runtime: owner.harness,
						role: analyticsAgentRole(owner),
						model_key: createHash("sha256").update(turn.model_id).digest("hex"),
					},
					{
						key: `${turn.id}:${step?.index ?? 0}:model-${metricIndex++}`,
						timestamp: new Date(),
					},
				);
			},
			fast: subscription?.fast,
			modelId: turn.model_id,
			messages,
			archiveHistory: (history) =>
				archiveModelContext(owner.userId, owner.id, history),
			instructions: `You are the ytimesy coding agent. Repository tools operate in this task's prepared checkout; paths are relative to that repository. Call read_repository_guidance before implementation and for nested paths; read applicable instructions and skill bodies completely. Search optional tools with search_tools. ${PREPARED_ENVIRONMENT_INSTRUCTIONS} Use read_environment_report for that setup report; do not pass its /tmp path to repository file readers. ${cloudAgentRoleInstructions(owner)}\n${PROJECT_KNOWLEDGE_INSTRUCTIONS}\nShared project knowledge (historical data, verify against this checkout):\n${JSON.stringify(projectKnowledge)}`,
			tools,
			signal: abort.signal,
			prepareMessages: async (history) => {
				history = await withBackgroundCommandContext({
					workspace,
					sessionId: owner.id,
					items,
					messages: history,
					signal: abort.signal,
					checkpoint: async (injected) => {
						messages = injected;
						await saveCheckpoint();
						await publishProgress?.("running");
					},
				});
				let current = await withDelegationContext(
					owner.userId,
					owner.id,
					history,
				);
				if (
					!owner.parentSessionId &&
					owner.projectId &&
					owner.candidateIndex == null
				) {
					current = await withCompletedTaskReviewContext({
						messages: current,
						children: await completedChildrenForReview(
							owner.userId,
							owner.projectId,
							owner.id,
						),
						signal: abort.signal,
						readHandoff: (taskId) =>
							Effect.runPromise(
								runAgentTaskTool(
									machines,
									{
										userId: owner.userId,
										projectId: owner.projectId,
										sessionId: owner.id,
										harnessId: owner.harness,
									},
									owner,
									{
										id: `${turn.id}:handoff:${taskId}`,
										tool: "read_task_handoff",
										arguments: { taskId },
									},
									{ signal: abort.signal, turnId: turn.id },
								),
							),
					});
				}
				if (current !== history) {
					messages = current;
					await saveCheckpoint();
				}
				return injectServerPeerMessages(owner.id, current, async (injected) => {
					messages = injected;
					await saveCheckpoint();
				});
			},
			beforeStep: async (history) => {
				failureStage = "budget";
				assertApiContextFits(history);
				abort.signal.throwIfAborted();
				if (evaluation)
					await reserveEvaluationRequest(
						evaluation,
						turn.model_id,
						turn.connection_revision,
					);
				if (!subscription)
					await reserveApiTokens(
						owner.userId,
						owner.id,
						Buffer.byteLength(JSON.stringify(history), "utf8") + 24_000,
					);
				failureStage = "model";
			},
			beforeCompaction: async (older) => {
				failureStage = "budget";
				if (evaluation)
					await reserveEvaluationRequest(
						evaluation,
						turn.model_id,
						turn.connection_revision,
					);
				if (!subscription)
					await reserveApiTokens(
						owner.userId,
						owner.id,
						Buffer.byteLength(JSON.stringify(older), "utf8") + 4_000,
					);
				failureStage = "model";
			},
			onEvent: async (event) => {
				if (step && "id" in event)
					event = { ...event, id: `step-${step.index}:${event.id}` };
				if (
					step &&
					event.type === "usage" &&
					previousUsage?.kind === "userMessage"
				)
					event = {
						...event,
						usage: addApiTokenUsage(
							previousUsage.apiUsage ?? null,
							event.usage,
						),
					};
				items = applyApiProgress(items, turn.id, event);
				if (evaluation && event.type === "usage")
					await recordEvaluationUsage(evaluation, turn.id, event.usage);
				if (Date.now() - flushedAt >= 250 || event.type === "finish") {
					progress.offer(items);
					if (event.type === "finish") await progress.drain();
					flushedAt = Date.now();
				}
			},
			onStep: async (history) => {
				failureStage = "saving";
				messages = history;
				await saveCheckpoint();
				failureStage = "model";
			},
		});
		failureStage = "saving";
		abort.signal.throwIfAborted();
		if (step && !Array.isArray(result) && result.outcome === "continue") {
			await saveCheckpoint();
			// Retain the same DO lease across step boundaries; only terminal outcomes release it.
			coordinated = false;
			return "continue";
		}
		// A model stop is not proof that detached verification finished. Re-observe at the publication boundary.
		const historyBeforeCompletion = messages;
		const finalHistory = await withBackgroundCommandContext({
			workspace,
			sessionId: owner.id,
			items,
			messages,
			signal: abort.signal,
			checkpoint: async (injected) => {
				messages = injected;
				await saveCheckpoint();
				await publishProgress?.("running");
			},
		});
		const pendingCommands = pendingAgentCommandIds(items);
		if (pendingCommands.length || finalHistory !== historyBeforeCompletion) {
			if (step) {
				messages = pendingCommands.length
					? [
							...finalHistory,
							{
								role: "user",
								content: `Execution completion gate: these owned background commands are still running: ${JSON.stringify(pendingCommands)}. Use wait_command and inspect their output; do not finalize or claim passing checks until they settle. This is runtime status, not a new user request.`,
							},
						]
					: finalHistory;
				await saveCheckpoint();
				coordinated = false;
				return "continue";
			}
			throw new IncompleteAgentTurn("background-command-review-required");
		}
		let lastUser = items.length - 1;
		while (lastUser >= 0 && items[lastUser].kind !== "userMessage") lastUser--;
		if (
			!items
				.slice(lastUser + 1)
				.some((item) => item.kind === "agentMessage" && item.text.trim())
		)
			throw new IncompleteAgentTurn("missing-final-result");
		failureStage = "commit";
		// Fence even commands whose acknowledgement was lost before it reached the durable cards.
		// Unlike best-effort cancellation on failure, publication requires a confirmed stop.
		if (execution) await stopApiTurnCommands(execution, turn.id);
		await commitCompletedSessionTurn(
			{ ...owner, providerRef: execution?.vm ?? owner.providerRef },
			items,
			{
				exec: (providerRef, argv, _env, timeout) =>
					(execution?.machines ?? machines).exec(
						WorkspaceId(providerRef),
						posixShellCommand(argv),
						timeout,
					),
				writeTextFile: (providerRef, path, contents) =>
					(execution?.machines ?? machines).writeTextFile(
						WorkspaceId(providerRef),
						path,
						contents,
					),
				readTextFile: (providerRef, path) =>
					(execution?.machines ?? machines).readTextFile(
						WorkspaceId(providerRef),
						path,
					),
			},
			abort.signal,
		);
		abort.signal.throwIfAborted();
		failureStage = "coordination";
		if (!(await coordinateConversationTurn("release", control)))
			throw new Error(
				"Conversation coordination lease was lost before completion.",
			);
		coordinated = false;
		failureStage = "saving";
		await progress.drain();
		const saved = await finalizeApiTurn(turn, "completed", items);
		if (saved !== "completed") {
			abort.abort();
			return saved === "cancelled" ? "cancelled" : "failed";
		}
		await publishProgress("completed").catch(() => {});
		await recordCloudProjectReport(owner, turn.id, items).catch(() => {
			console.warn(
				"Completed turn saved, but its project report needs recovery.",
			);
		});
		if (owner.parentSessionId) {
			const eventId = await saveAgentTaskResultAndEvent({
				sessionId: owner.id,
				turnId: turn.id,
				eventType: "completed",
				summary:
					items
						.slice(lastUser + 1)
						.filter((item) => item.kind === "agentMessage")
						.map((item) => item.text)
						.join("\n")
						.slice(-16000) ||
					"Turn ended without a recorded final summary; inspect the task before accepting it.",
			});
			if (eventId) await enqueueAgentTaskEvent(eventId).catch(() => {});
		}
		return "completed";
	} catch (error) {
		await progress.drain().catch(() => {});
		if (!abort.signal.aborted || heartbeatFailed || progressFailed)
			console.warn("API turn failed", {
				stage: failureStage,
				...apiTurnFailureClassification(error),
			});
		const failureMessage = progressFailed
			? "Turn progress could not be saved. Inspect the task before retrying."
			: abort.signal.aborted
				? `Run stopped. ${abort.signal.reason instanceof Error && ["Turn ownership or cancellation state changed.", "Conversation coordination lease was lost.", "Turn heartbeat or coordination service became unavailable."].includes(abort.signal.reason.message) ? `${abort.signal.reason.message} ` : ""}Inspect any in-flight command before continuing.`
				: apiTurnFailureMessage(failureStage, error);
		items = [
			...items,
			{
				kind: "error",
				id: SessionItemId(`${turn.id}:error`),
				message: failureMessage,
			},
		];
		items = applyApiProgress(items, turn.id, {
			type: "finish",
			inputTokens: null,
			outputTokens: null,
			reason: "error",
		});
		const saved = await finalizeApiTurn(
			turn,
			abort.signal.aborted && !heartbeatFailed && !progressFailed
				? "cancelled"
				: "failed",
			items,
		);
		if (saved)
			await publishProgress?.(saved === "cancelled" ? "idle" : "failed").catch(
				() => {},
			);
		if (saved === "failed") {
			const eventId = await saveAgentTaskResultAndEvent({
				sessionId: turn.session_id,
				turnId: turn.id,
				eventType: "failed",
				summary: failureMessage,
			});
			if (eventId) await enqueueAgentTaskEvent(eventId).catch(() => {});
		}
		abort.abort();
		return saved === "cancelled" ? "cancelled" : "failed";
	} finally {
		clearInterval(heartbeat);
		await heartbeatPending;
		await coordinationHeartbeatPending;
		if (abort.signal.aborted) stopCommands();
		await commandStop;
		abort.signal.removeEventListener("abort", stopCommands);
		step?.signal.removeEventListener("abort", stopForDeadline);
		if (coordinated)
			await coordinateConversationTurn("release", control).catch(() => {});
	}
}
