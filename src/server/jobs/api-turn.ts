import { createHash } from "node:crypto";
import type { ToolSet } from "ai";
import { Effect } from "effect";
import { visualQaInstructions } from "#/domain/agent-desktop";
import { cloudAgentRoleInstructions } from "#/domain/agent-orchestration";
import { assertApiContextFits } from "#/domain/api-conversation";
import { applyApiProgress, recordedContextUsage } from "#/domain/api-progress";
import { type ApiTokenUsage, addApiTokenUsage } from "#/domain/api-token-usage";
import {
	ApiTurnCancelled,
	type ApiTurnFailureStage,
	apiTurnFailureClassification,
	apiTurnFailureMessage,
	IncompleteAgentTurn,
	LifecycleHookRefusal,
} from "#/domain/api-turn-failure";
import { CoordinationFailure } from "#/domain/conversation-turn-control";
import { PREPARED_ENVIRONMENT_INSTRUCTIONS } from "#/domain/environment-context";
import { SessionItemId, WorkspaceId } from "#/domain/ids";
import { prepareInterruptedStep } from "#/domain/interrupted-step";
import { officialProviderEndpoint } from "#/domain/model-connection";
import { modelStepLimit } from "#/domain/model-workflow";
import { posixShellCommand } from "#/domain/posix-command";
import { PROJECT_KNOWLEDGE_INSTRUCTIONS } from "#/domain/project-knowledge";
import { rootAgentMode } from "#/domain/root-agent-mode";
import { subscriptionTurnSettings } from "#/domain/subscription-turn";
import {
	completedChildrenForReview,
	withDelegationContext,
} from "../adapters/agent-delegation-context";
import { agentSessionMetadataForOwner } from "../adapters/agent-sessions";
import { completedLifecycleContinuations } from "../adapters/agent-task-command-receipts";
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
import { readBuilderWorkState } from "../adapters/builder-work-state";
import { archiveModelContext } from "../adapters/context-archives";
import { coordinateConversationTurn } from "../adapters/conversation-turn-control";
import {
	assertEvaluationActive,
	type EvaluationRun,
	evaluationRunForTask,
	recordEvaluationUsage,
	reserveEvaluationRequest,
} from "../adapters/harness-evaluation";
import { connectableMcpServers } from "../adapters/mcp-servers";
import { loadModelConnection } from "../adapters/model-connections";
import { nativeWebSearchTools } from "../adapters/native-web-search";
import { enabledPluginComponents } from "../adapters/plugin-installs";
import { injectServerPeerMessages } from "../adapters/server-peer-inbox";
import { readVerificationBaseline } from "../adapters/turn-verification";
import { hasManagedCodexAuth } from "../auth/codex-managed-auth";
import { discoveredToolsFromSession } from "../services/agent-tool-discovery";
import type { AgentToolWorkspace } from "../services/agent-tool-workspace";
import { runApiAgent, runApiAgentStep } from "../services/api-agent-runtime";
import { apiAgentTools } from "../services/api-agent-tools";
import { stopApiTurnCommands } from "../services/api-command-scope";
import { deferredApiTurnWorkspace } from "../services/api-turn-workspace";
import { automaticRepositoryContext } from "../services/automatic-repository-context";
import {
	pendingAgentCommandIds,
	withBackgroundCommandContext,
} from "../services/background-command-context";
import { builderShellTools } from "../services/builder-shell-surface";
import { withBuilderWorkState } from "../services/builder-work-state";
import {
	runCodexSubscriptionAgent,
	runCodexSubscriptionAgentStep,
} from "../services/codex-subscription-agent";
import { withCompletedTaskReviewContext } from "../services/completed-task-review-context";
import { ensureConversationCodePoint } from "../services/conversation-recovery";
import { fusionConfigForTurn, runFusionTurn } from "../services/fusion-turn";
import { harnessLifecycleHooks } from "../services/harness-lifecycle-hooks";
import { runAgentTaskTool } from "../services/harness-workspace-session";
import { journaledToolOperation } from "../services/journaled-tool-operation";
import { turnOAuthProvider } from "../services/mcp-oauth";
import { connectMcpTools } from "../services/mcp-tools";
import type { ModelAgentInput } from "../services/model-agent-loop";
import { withPlanMode, withPlanModeNotice } from "../services/plan-mode";
import {
	pluginSkillsInstructions,
	pluginSkillTools,
} from "../services/plugin-skill-tools";
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
	step?: {
		index: number;
		signal: AbortSignal;
		limitReached?: boolean;
		/** The same step is being re-run after its executor restarted mid-step. */
		resumed?: boolean;
	},
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
	if (step?.resumed)
		({ messages, items } = prepareInterruptedStep(
			messages,
			items,
			turn.id,
			step.index,
		));
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
	let coordinationFailure: CoordinationFailure | undefined;
	let progressFailed = false;
	const progress = turnProgressWriter(
		(snapshot) => publishApiTurnProgress(turn, snapshot),
		(error) => {
			if (error instanceof ApiTurnCancelled) {
				abort.abort(error);
				return;
			}
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
	let closeMcp: (() => Promise<void>) | undefined;
	let lastCoordinationRenewal = 0;
	let evaluation: EvaluationRun | null = null;
	const heartbeat = setInterval(() => {
		const guardHeartbeat = (stage: string, operation: Promise<void>) =>
			operation.catch((error: unknown) => {
				heartbeatFailed = true;
				if (error instanceof CoordinationFailure) coordinationFailure ??= error;
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
		// The turn already carries the session's items (every write mirrors both).
		const metadata = await agentSessionMetadataForOwner(
			turn.user_id,
			turn.session_id,
		);
		const owner = metadata && { ...metadata, items: turn.items };
		if (!owner) throw new Error("Task no longer exists.");
		if (process.env.YTIMESY_HARNESS_EVALUATION_ENABLED === "1")
			evaluation = await evaluationRunForTask(owner.userId, owner.id);
		const subscription = subscriptionTurnSettings(turn.connection_revision);
		// The subscription endpoint rejects the public Responses apply_patch tool.
		// Writers retain the same V4A editor through its function-tool schema.
		let nativePatch = false;
		// The provider's hosted web search, on direct connections to official endpoints only.
		let webSearch: ToolSet = {};
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
			if (officialProviderEndpoint(connection))
				webSearch = nativeWebSearchTools(connection.provider);
		}
		// Fusion: a root lead that works in its own workspace with a sidekick.
		const fusion = fusionConfigForTurn({
			session: owner,
			subscription: Boolean(subscription),
			stepMode: Boolean(step),
			leadModelId: turn.model_id,
		});
		// Builder-direct (launch default): the root chat is the builder itself.
		const direct =
			!owner.parentSessionId && !fusion && rootAgentMode() === "builder";
		const prepareWorkspace = deferredApiTurnWorkspace(
			machines,
			owner,
			abort.signal,
		);
		let codePoint: Promise<void> | undefined;
		const workspace = async () => {
			execution = await prepareWorkspace();
			if (
				fusion ||
				direct ||
				(owner.parentSessionId && owner.taskAccess === "read_write")
			) {
				const prompt = [...items]
					.reverse()
					.find((item) => item.kind === "userMessage");
				if (prompt) {
					codePoint ??= ensureConversationCodePoint(
						owner.userId,
						owner.id,
						prompt.id,
						execution,
					);
					await codePoint;
				}
			}
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
		const originalTools = apiAgentTools({
			machines,
			session: owner,
			workspace,
			turnId: turn.id,
			nativePatch,
			toolCallPrefix: step ? `step-${step.index}:` : undefined,
			signal: abort.signal,
			writable: Boolean(fusion) || direct,
		});
		const repositoryContext = automaticRepositoryContext({
			tools: originalTools,
			workspace,
			signal: abort.signal,
			onEvent: async (event) => {
				items = applyApiProgress(items, turn.id, event);
				progress.offer(items);
			},
		});
		const hooks = harnessLifecycleHooks({
			workspace,
			turnId: turn.id,
			readOnly:
				!fusion &&
				!direct &&
				(!owner.parentSessionId || owner.taskAccess !== "read_write"),
			continuationCount: () =>
				completedLifecycleContinuations(owner.id, turn.id),
			signal: abort.signal,
			baseline: ({ cwd }) =>
				readVerificationBaseline(owner.userId, owner.id, cwd),
			once: (id, run) =>
				journaledToolOperation(
					{
						sessionId: owner.id,
						requestId: `${turn.id}:${id}`,
						fingerprint: createHash("sha256").update(id).digest("hex"),
						signal: abort.signal,
					},
					run,
				),
		});
		const currentTask = [...items]
			.reverse()
			.find((item) => item.kind === "userMessage");
		const planMode =
			currentTask?.kind === "userMessage" && currentTask.mode === "plan";
		// Writable builders get the validated shell surface; leads keep coordination tools.
		const shellBuilder =
			Boolean(fusion) ||
			direct ||
			(Boolean(owner.parentSessionId) && owner.taskAccess === "read_write");
		const surfaceTools = shellBuilder
			? builderShellTools(repositoryContext.tools)
			: repositoryContext.tools;
		// The user's remote MCP servers are called from here; credentials never reach the VM.
		const mcp = await connectMcpTools(
			await Promise.all(
				(await connectableMcpServers(owner.userId, owner.projectId ?? null))
					// OAuth servers join once the user has signed in.
					.filter((server) => server.auth !== "oauth" || server.sealedOAuth)
					.map(async (server) => ({
						name: server.name,
						url: server.url,
						headers: server.headers,
						authProvider:
							server.auth === "oauth"
								? await turnOAuthProvider({
										userId: owner.userId,
										serverId: server.id,
										sealedOAuth: server.sealedOAuth,
										appUrl: process.env.APP_URL ?? "http://localhost:3000",
									})
								: undefined,
					})),
			),
			{ signal: abort.signal },
		);
		closeMcp = mcp.close;
		const plugins = await enabledPluginComponents(
			owner.userId,
			owner.projectId ?? null,
		);
		const withMcp = {
			...surfaceTools,
			...mcp.tools,
			...pluginSkillTools(plugins),
			...webSearch,
		};
		const tools = planMode
			? withPlanMode(hooks.wrap(withMcp))
			: hooks.wrap(withMcp);
		if (planMode) messages = withPlanModeNotice(messages);
		if (mcp.unavailable.length) {
			const notice = `MCP servers unavailable this turn (connection or credentials failed): ${mcp.unavailable.join(", ")}. Their tools are not offered; continue without them.`;
			if (!messages.some((message) => message.content === notice))
				messages = [...messages, { role: "user", content: notice }];
		}
		const projectKnowledge = await loadCloudProjectKnowledge(
			owner,
			currentTask?.kind === "userMessage"
				? currentTask.text
				: (owner.taskPrompt ?? owner.title),
		);
		let flushedAt = 0;
		let metricIndex = 0;
		failureStage = "model";
		const toolSurface =
			owner.parentSessionId || fusion || direct
				? "implementation"
				: "coordination";
		if (step && (step.limitReached || step.index > modelStepLimit(toolSurface)))
			throw new IncompleteAgentTurn("tool-calls");
		// Once per turn, before its first model request; replayed steps reuse the journal.
		if (!step || step.index === 0) {
			const submitted = await hooks.userPromptSubmit(
				currentTask?.kind === "userMessage" ? currentTask.text : "",
			);
			if (submitted.block) throw new LifecycleHookRefusal(submitted.reason);
		}
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
		// Fusion: the evaluation guard counts lead and sidekick tokens together.
		let leadUsage: ApiTokenUsage | null = null;
		let sidekickUsage: ApiTokenUsage | null = null;
		const agentInput: ModelAgentInput = {
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
			toolSurface,
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
			instructions: `You are the ytimesy coding agent. Repository tools operate in this task's prepared checkout; paths are relative to that repository. Call read_repository_guidance before implementation and for nested paths; read applicable instructions and skill bodies completely.${shellBuilder ? "" : " Search optional tools with search_tools."} ${PREPARED_ENVIRONMENT_INSTRUCTIONS} Use read_environment_report for that setup report; do not pass its /tmp path to repository file readers. ${fusion ? "" : cloudAgentRoleInstructions(owner, { shellBuilder, direct })}${shellBuilder && "browser_screenshot" in tools ? ` ${visualQaInstructions()}` : ""}\n${pluginSkillsInstructions(plugins)}\n${PROJECT_KNOWLEDGE_INSTRUCTIONS}\nShared project knowledge (historical data, verify against this checkout):\n${JSON.stringify(projectKnowledge)}`,
			tools,
			signal: abort.signal,
			restoreInstructions: async (history) => {
				history = await repositoryContext.restoreInstructions(history);
				history = withBuilderWorkState(
					history,
					await readBuilderWorkState(owner.userId, owner.id),
				);
				await hooks.postCompact(history);
				return hooks.drain(history);
			},
			afterTools: async (history) =>
				hooks.drain(await repositoryContext.afterTools(history)),
			prepareMessages: async (history) => {
				history = hooks.drain(await repositoryContext.prepare(history));
				history = withBuilderWorkState(
					history,
					await readBuilderWorkState(owner.userId, owner.id),
				);
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
				if (evaluation && event.type === "usage") {
					leadUsage = event.usage;
					await recordEvaluationUsage(
						evaluation,
						turn.id,
						addApiTokenUsage(sidekickUsage, event.usage),
					);
				}
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
		};
		const run = fusion
			? (input: ModelAgentInput) =>
					runFusionTurn({
						sessionId: owner.id,
						lead: input,
						config: fusion,
						// The shared workspace: shell tools behind the same hooks and plan mode.
						workspaceTools: planMode
							? withPlanMode(hooks.wrap(surfaceTools))
							: hooks.wrap(surfaceTools),
						beforeSidekickRequest: async () => {
							abort.signal.throwIfAborted();
							if (evaluation)
								await reserveEvaluationRequest(
									evaluation,
									turn.model_id,
									turn.connection_revision,
								);
						},
						onSidekickEvent: async (event) => {
							// Both counters only grow, so their sum is a valid cumulative checkpoint.
							if (evaluation && event.type === "usage") {
								sidekickUsage = event.usage;
								await recordEvaluationUsage(
									evaluation,
									turn.id,
									addApiTokenUsage(leadUsage, event.usage),
								);
							}
							// The user sees the sidekick's tool work; its report reaches them through the lead.
							if (event.type !== "tool-call" && event.type !== "tool-result")
								return;
							items = applyApiProgress(items, turn.id, {
								...event,
								id: `sidekick:${event.id}`,
							});
							progress.offer(items);
						},
					})
			: runAgent;
		let result = await run(agentInput);
		while (!step && (await hooks.stop(messages))) {
			messages = hooks.drain(messages);
			await saveCheckpoint();
			result = await run({ ...agentInput, messages });
		}
		if (
			step &&
			!Array.isArray(result) &&
			result.outcome === "completed" &&
			(await hooks.stop(messages))
		) {
			messages = hooks.drain(messages);
			await saveCheckpoint();
			coordinated = false;
			return "continue";
		}
		messages = hooks.drain(messages);
		await saveCheckpoint();
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
				stage: coordinationFailure ? "coordination" : failureStage,
				...apiTurnFailureClassification(coordinationFailure ?? error),
				// Development diagnostics only: messages can contain provider details.
				...(process.env.YTIMESY_DEBUG_TURN_ERRORS === "1" &&
				error instanceof Error
					? {
							debug: `${error.name}: ${error.message}`.slice(0, 400),
							stack: error.stack?.split("\n").slice(0, 6).join(" | "),
						}
					: {}),
			});
		const failureMessage = progressFailed
			? "Turn progress could not be saved. Inspect the task before retrying."
			: coordinationFailure
				? apiTurnFailureMessage("coordination", coordinationFailure)
				: abort.signal.aborted
					? `Run stopped. ${abort.signal.reason instanceof Error && ["Turn ownership or cancellation state changed.", "Conversation coordination lease was lost.", "Turn heartbeat or coordination service became unavailable."].includes(abort.signal.reason.message) ? `${abort.signal.reason.message} ` : ""}Inspect any in-flight command before continuing.`
					: apiTurnFailureMessage(failureStage, error) +
						developmentFailureDetail(error);
		const userCancelled = abort.signal.reason instanceof ApiTurnCancelled;
		if (!userCancelled)
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
		await closeMcp?.().catch(() => {});
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

/** Development diagnostics only (YTIMESY_DEBUG_TURN_ERRORS=1): the provider's own error. */
function developmentFailureDetail(error: unknown) {
	if (
		process.env.YTIMESY_DEBUG_TURN_ERRORS !== "1" ||
		!(error instanceof Error)
	)
		return "";
	const inner = (error as { providerError?: unknown }).providerError;
	const detail =
		inner instanceof Error
			? `${inner.name}: ${inner.message} ${JSON.stringify((inner as { responseBody?: unknown }).responseBody ?? "")}`
			: inner
				? JSON.stringify(inner)
				: `${error.name}: ${error.message}`;
	return ` [debug ${detail.slice(0, 600)}]`;
}
