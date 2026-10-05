import {
	AGENT_ORCHESTRATION_INSTRUCTIONS,
	agentSessionRoleInstructions,
} from "#/domain/agent-orchestration";
import { assertApiContextFits } from "#/domain/api-conversation";
import { applyApiProgress, recordedContextUsage } from "#/domain/api-progress";
import { addApiTokenUsage } from "#/domain/api-token-usage";
import {
	type ApiTurnFailureStage,
	apiTurnFailureMessage,
	IncompleteAgentTurn,
} from "#/domain/api-turn-failure";
import { PREPARED_ENVIRONMENT_INSTRUCTIONS } from "#/domain/environment-context";
import { SessionItemId, WorkspaceId } from "#/domain/ids";
import { posixShellCommand } from "#/domain/posix-command";
import { PROJECT_KNOWLEDGE_INSTRUCTIONS } from "#/domain/project-knowledge";
import { subscriptionTurnSettings } from "#/domain/subscription-turn";
import { withDelegationContext } from "../adapters/agent-delegation-context";
import { agentSessionForOwner } from "../adapters/agent-sessions";
import { saveAgentTaskResultAndEvent } from "../adapters/agent-task-events";
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
import type { AgentToolWorkspace } from "../services/agent-tool-workspace";
import { runApiAgent, runApiAgentStep } from "../services/api-agent-runtime";
import { apiAgentTools } from "../services/api-agent-tools";
import { stopApiTurnCommands } from "../services/api-command-scope";
import { deferredApiTurnWorkspace } from "../services/api-turn-workspace";
import {
	runCodexSubscriptionAgent,
	runCodexSubscriptionAgentStep,
} from "../services/codex-subscription-agent";
import {
	loadCloudProjectKnowledge,
	recordCloudProjectReport,
} from "../services/project-knowledge";
import { machinesForAgentSession } from "../services/session-workspace-machines";
import { commitCompletedSessionTurn } from "../services/turn-commit";
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
		if (heartbeatBusy) return;
		heartbeatBusy = true;
		let heartbeatStage = "database-renewal";
		heartbeatPending = renewApiTurn(turn)
			.then(async (alive) => {
				if (!alive)
					abort.abort(
						new Error("Turn ownership or cancellation state changed."),
					);
				if (evaluation) {
					heartbeatStage = "evaluation-guard";
					await assertEvaluationActive(evaluation);
				}
				if (
					alive &&
					coordinated &&
					Date.now() - lastCoordinationRenewal >= 10_000
				) {
					heartbeatStage = "coordination-renewal";
					if (!(await coordinateConversationTurn("renew", control)))
						abort.abort(new Error("Conversation coordination lease was lost."));
					lastCoordinationRenewal = Date.now();
				}
			})
			.catch((error: unknown) => {
				// Only classifications belong in logs: database errors may contain secrets.
				const code =
					error && typeof error === "object" && "code" in error
						? String(error.code)
						: "unknown";
				console.warn("Turn heartbeat failed", {
					stage: heartbeatStage,
					code: /^[A-Z0-9_]{1,32}$/.test(code) ? code : "unknown",
					name:
						error instanceof Error && /^[A-Za-z]{1,32}$/.test(error.name)
							? error.name
							: "unknown",
				});
				abort.abort(
					new Error(
						"Turn heartbeat or coordination service became unavailable.",
					),
				);
			})
			.finally(() => {
				heartbeatBusy = false;
			});
	}, 1000);
	try {
		if (
			!turn.lease_id ||
			!(await coordinateConversationTurn("acquire", control))
		)
			throw new Error("The conversation is already running or was stopped.");
		coordinated = true;
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
			if (turnStatus === "running") await publishApiTurnProgress(turn, items);
		};
		await publishProgress("running");
		const tools = apiAgentTools({
			machines,
			session: owner,
			workspace,
			turnId: turn.id,
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
			fast: subscription?.fast,
			modelId: turn.model_id,
			messages,
			archiveHistory: (history) =>
				archiveModelContext(owner.userId, owner.id, history),
			instructions: `You are the ytimesy coding agent. Repository tools operate in this task's prepared checkout; paths are relative to that repository. Read repository instructions before editing. ${PREPARED_ENVIRONMENT_INSTRUCTIONS} Use read_environment_report for that setup report; do not pass its /tmp path to repository file readers. ${AGENT_ORCHESTRATION_INSTRUCTIONS} ${agentSessionRoleInstructions(owner)}\n${PROJECT_KNOWLEDGE_INSTRUCTIONS}\nShared project knowledge (historical data, verify against this checkout):\n${JSON.stringify(projectKnowledge)}`,
			tools,
			signal: abort.signal,
			prepareMessages: async (history) => {
				const current = await withDelegationContext(
					owner.userId,
					owner.id,
					history,
				);
				return injectServerPeerMessages(owner.id, current, async (injected) => {
					messages = injected;
					await checkpointApiTurn(turn, messages, items);
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
					failureStage = "saving";
					await publishProgress?.("running");
					failureStage = "model";
					flushedAt = Date.now();
				}
			},
			onStep: async (history) => {
				failureStage = "saving";
				messages = history;
				await checkpointApiTurn(turn, messages, items);
				failureStage = "model";
			},
		});
		failureStage = "saving";
		abort.signal.throwIfAborted();
		if (step && !Array.isArray(result) && result.outcome === "continue") {
			await checkpointApiTurn(turn, messages, items);
			// Retain the same DO lease across step boundaries; only terminal outcomes release it.
			coordinated = false;
			return "continue";
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
		);
		abort.signal.throwIfAborted();
		failureStage = "saving";
		if (!(await coordinateConversationTurn("release", control)))
			throw new Error(
				"Conversation coordination lease was lost before completion.",
			);
		coordinated = false;
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
		items = [
			...items,
			{
				kind: "error",
				id: SessionItemId(`${turn.id}:error`),
				message: abort.signal.aborted
					? `Run stopped. ${abort.signal.reason instanceof Error && ["Turn ownership or cancellation state changed.", "Conversation coordination lease was lost.", "Turn heartbeat or coordination service became unavailable."].includes(abort.signal.reason.message) ? `${abort.signal.reason.message} ` : ""}Inspect any in-flight command before continuing.`
					: apiTurnFailureMessage(failureStage, error),
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
			abort.signal.aborted ? "cancelled" : "failed",
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
				summary: apiTurnFailureMessage(failureStage, error),
			});
			if (eventId) await enqueueAgentTaskEvent(eventId).catch(() => {});
		}
		abort.abort();
		return saved === "cancelled" ? "cancelled" : "failed";
	} finally {
		clearInterval(heartbeat);
		await heartbeatPending;
		if (abort.signal.aborted) stopCommands();
		await commandStop;
		abort.signal.removeEventListener("abort", stopCommands);
		step?.signal.removeEventListener("abort", stopForDeadline);
		if (coordinated)
			await coordinateConversationTurn("release", control).catch(() => {});
	}
}
