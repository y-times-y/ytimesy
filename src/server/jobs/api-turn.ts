import { createHash } from "node:crypto";
import type { ModelMessage, ToolSet } from "ai";
import { Effect } from "effect";
import { agentPlanState } from "#/domain/agent-plan";
import {
	assertApiContextFits,
	isUserRequestMessage,
} from "#/domain/api-conversation";
import { applyApiProgress, recordedContextUsage } from "#/domain/api-progress";
import { addApiTokenUsage } from "#/domain/api-token-usage";
import {
	ApiTurnCancelled,
	type ApiTurnFailureStage,
	apiTurnFailureClassification,
	apiTurnFailureMessage,
	IncompleteAgentTurn,
	LifecycleHookRefusal,
	SafeApiModelFailure,
} from "#/domain/api-turn-failure";
import type { ApiTurnSettings } from "#/domain/api-turn-settings";
import {
	CoordinationFailure,
	TURN_COORDINATION_LEASE_MS,
	type TurnControl,
} from "#/domain/conversation-turn-control";
import { DEFAULT_HARNESS_VARIANT } from "#/domain/harness-variant";
import { SessionItemId, WorkspaceId } from "#/domain/ids";
import { prepareInterruptedStep } from "#/domain/interrupted-step";
import { withMemoryRecall } from "#/domain/memory-marker";
import { officialProviderEndpoint } from "#/domain/model-connection";
import {
	type FailoverReason,
	failoverExhaustedDetail,
	failoverNotice,
	failoverQuestion,
	failoverRuntimeNote,
	forcedDevelopmentOutage,
	nextTurnFailover,
	routeConnectionKey,
	routeKey,
	servingRoute,
} from "#/domain/model-failover";
import {
	developmentOutageError,
	failoverReason,
} from "#/domain/model-failover-reason";
import { modelStepLimit } from "#/domain/model-workflow";
import { posixShellCommand } from "#/domain/posix-command";
import { agentSecretsEnvFile } from "#/domain/project-secret";
import { modelSwitchHistory } from "#/domain/runtime-handoff";
import type { ModelSwitchItem, SessionItem } from "#/domain/session-item";
import { subscriptionTurnSettings } from "#/domain/subscription-turn";
import {
	completedChildrenForReview,
	hasDelegatedTasks,
	withDelegationContext,
} from "../adapters/agent-delegation-context";
import { agentSessionMetadataForOwner } from "../adapters/agent-sessions";
import { completedLifecycleContinuations } from "../adapters/agent-task-command-receipts";
import { saveAgentTaskResultAndEvent } from "../adapters/agent-task-events";
import { captureServerAnalytics } from "../adapters/analytics";
import {
	type ApiTurn,
	apiTurnCancelRequested,
	checkpointApiTurn,
	finalizeApiTurn,
	publishApiTurnProgress,
	renewApiTurn,
} from "../adapters/api-turns";
import { reserveApiTokens } from "../adapters/api-usage-budget";
import { warmCodexSubscriptionCatalog } from "../adapters/codex-subscription";
import { archiveModelContext } from "../adapters/context-archives";
import { conversationPointCodeRef } from "../adapters/conversation-recovery";
import { coordinateConversationTurn } from "../adapters/conversation-turn-control";
import {
	devEvalUsersEnabled,
	harnessVariantForUser,
} from "../adapters/dev-eval-users";
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
import { agentTurnInstructions } from "../services/agent-turn-instructions";
import { runApiAgent, runApiAgentStep } from "../services/api-agent-runtime";
import { apiAgentTools } from "../services/api-agent-tools";
import { stopApiTurnCommands } from "../services/api-command-scope";
import { deferredApiTurnWorkspace } from "../services/api-turn-workspace";
import { automaticRepositoryContext } from "../services/automatic-repository-context";
import {
	pendingAgentCommandIds,
	withBackgroundCommandContext,
} from "../services/background-command-context";
import { builderToolSurface } from "../services/builder-shell-surface";
import {
	runCodexSubscriptionAgent,
	runCodexSubscriptionAgentStep,
} from "../services/codex-subscription-agent";
import { compactionStateSnapshot } from "../services/compaction-state-snapshot";
import { withCompletedTaskReviewContext } from "../services/completed-task-review-context";
import { ensureConversationCodePoint } from "../services/conversation-recovery";
import { harnessLifecycleHooks } from "../services/harness-lifecycle-hooks";
import { runAgentTaskTool } from "../services/harness-workspace-session";
import { journaledToolOperation } from "../services/journaled-tool-operation";
import { turnOAuthProvider } from "../services/mcp-oauth";
import { mcpToolSurface } from "../services/mcp-tool-surface";
import { connectMcpTools } from "../services/mcp-tools";
import {
	materializeMessageAttachments,
	sessionAttachments,
} from "../services/message-attachments";
import type { ModelAgentInput } from "../services/model-agent-loop";
import { planModelFailover } from "../services/model-failover";
import {
	PLAN_CONTINUE_NOTICE,
	PLAN_END_TURN_TOOLS,
	PLAN_REVISION_NOTICE,
	PlanLock,
	planTools,
	withPlanMode,
	withPlanModeNotice,
} from "../services/plan-mode";
import { pluginSkillTools } from "../services/plugin-skill-tools";
import {
	loadCloudProjectKnowledge,
	recordCloudProjectReport,
} from "../services/project-knowledge";
import {
	loadAgentProjectSecrets,
	writeAgentProjectSecrets,
} from "../services/project-secrets";
import { withRedactedResults } from "../services/redacted-tools";
import {
	SECRET_REQUEST_END_TURN_TOOLS,
	secretRequestTools,
} from "../services/secret-request-tool";
import { machinesForAgentSession } from "../services/session-workspace-machines";
import { recordStepTiming, timed } from "../services/step-timing";
import { analyticsAgentRole } from "../services/turn-analytics";
import { commitCompletedSessionTurn } from "../services/turn-commit";
import { forgetTurnMemo, turnMemo } from "../services/turn-memo";
import { turnMemory } from "../services/turn-memory";
import { turnProgressWriter } from "../services/turn-progress-writer";
import { turnWorkspaceReuse } from "../services/turn-workspace-reuse";
import type { WorkspaceMachines } from "../services/workspace-machines";
import { enqueueAgentTaskEvent } from "./queue";

/**
 * Acquires the chat's coordination lease, waiting out a brief holder instead
 * of failing: a code restore holds the lease until just before it commits, and
 * a hold whose release failed lapses within one lease period. A turn that was
 * stopped meanwhile ends the wait through its heartbeat's abort.
 */
async function acquireConversationTurn(
	control: TurnControl,
	signal: AbortSignal,
) {
	const deadline = Date.now() + TURN_COORDINATION_LEASE_MS + 5_000;
	for (;;) {
		if (await coordinateConversationTurn("acquire", control)) return true;
		if (signal.aborted || Date.now() >= deadline) return false;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(done, 1000);
			function done() {
				clearTimeout(timer);
				signal.removeEventListener("abort", done);
				resolve();
			}
			signal.addEventListener("abort", done, { once: true });
		});
		if (signal.aborted) return false;
	}
}

type ApiTurnStepOutcome = "continue" | "completed" | "failed" | "cancelled";

type ApiTurnStep = {
	index: number;
	signal: AbortSignal;
	limitReached?: boolean;
	/** Latest epoch ms a tool may keep waiting on a command inside this step. */
	waitDeadlineAt?: number;
	/** The same step is being re-run after its executor restarted mid-step. */
	resumed?: boolean;
};

/**
 * Step mode is for the external durable orchestrator; the default preserves
 * the local worker. A turn that failed over keeps its lease: in step mode its
 * next step runs on the fallback; the local worker continues it here.
 */
export async function runApiTurn(
	machines: WorkspaceMachines,
	turn: ApiTurn,
	step?: ApiTurnStep,
): Promise<ApiTurnStepOutcome> {
	// Bounded: every failover adds a route to the turn's tried set (MAX_TURN_FAILOVERS).
	for (let continued = false; ; continued = true) {
		const outcome = await runApiTurnAttempt(machines, turn, step, continued);
		if (typeof outcome === "string") {
			if (outcome !== "continue") forgetTurnMemo(turn.id);
			return outcome;
		}
		if (step) return "continue";
		turn = outcome.failedOver;
	}
}

async function runApiTurnAttempt(
	machines: WorkspaceMachines,
	turn: ApiTurn,
	step: ApiTurnStep | undefined,
	/** The local worker is continuing this turn on a fallback route. */
	continued: boolean,
): Promise<ApiTurnStepOutcome | { failedOver: ApiTurn }> {
	const abort = new AbortController();
	// The executor's step budget and turn deadline abort with a TimeoutError.
	const stopForDeadline = () =>
		abort.abort(
			(step?.signal.reason as { name?: unknown } | undefined)?.name ===
				"TimeoutError"
				? new TurnTimeLimitReached()
				: new Error("Durable step was interrupted."),
		);
	step?.signal.addEventListener("abort", stopForDeadline, { once: true });
	if (step?.signal.aborted) stopForDeadline();
	let items = turn.items;
	const previousUsage =
		step || continued
			? [...items].reverse().find((item) => item.kind === "userMessage")
			: undefined;
	// After a failover the rest of the turn runs on the fallback; the turn row
	// keeps the user's choice, so their next message tries it again.
	const route = servingRoute(turn);
	let failoverScope:
		| {
				evaluation: boolean;
				child: boolean;
				runtime: "codex" | "api";
				role: ReturnType<typeof analyticsAgentRole>;
		  }
		| undefined;
	let failedAttempt:
		| {
				committed: ModelMessage[];
				droppedStepSaved: boolean;
				uncommittedIds: readonly string[];
		  }
		| undefined;
	let messages = turn.messages;
	// Steps of one turn share their workspace preparation; a re-run step starts clean.
	const workspaceReuse =
		step && turn.lease_id
			? turnWorkspaceReuse(`${turn.id}:${turn.lease_id}`)
			: undefined;
	if (step?.resumed) workspaceReuse?.forget();
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
	// History is replaced, never mutated, so an unchanged pair is already saved.
	let checkpointed:
		| { messages: ModelMessage[]; items: typeof items }
		| undefined;
	const saveCheckpoint = () =>
		timed("turn:checkpoint", async () => {
			await progress.drain();
			if (checkpointed?.messages === messages && checkpointed.items === items)
				return;
			const saving = { messages, items };
			await checkpointApiTurn(turn, saving.messages, saving.items);
			checkpointed = saving;
		});
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
			!(await timed("turn:acquire", () =>
				acquireConversationTurn(control, abort.signal),
			))
		)
			throw new Error("The conversation is already running or was stopped.");
		coordinated = true;
		failureStage = "connection";
		lastCoordinationRenewal = Date.now();
		const subscription = subscriptionTurnSettings(route.connectionRevision);
		// Read-only setup reads overlap the lease renewal; nothing uses them
		// unless the renewal confirms this turn still owns its lease.
		// The turn already carries the session's items (every write mirrors both).
		const loadingMetadata = timed("turn:metadata", () =>
			agentSessionMetadataForOwner(turn.user_id, turn.session_id),
		);
		const checkingCodexAuth =
			subscription && !route.connectionId
				? timed("turn:codexAuth", () => hasManagedCodexAuth(turn.user_id))
				: Promise.resolve(false);
		loadingMetadata.catch(() => {});
		checkingCodexAuth.catch(() => {});
		if (!(await timed("turn:renew", () => renewApiTurn(turn)))) {
			abort.abort();
			abort.signal.throwIfAborted();
		}
		const metadata = await loadingMetadata;
		const owner = metadata && { ...metadata, items: turn.items };
		if (!owner) throw new Error("Task no longer exists.");
		if (process.env.YTIMESY_HARNESS_EVALUATION_ENABLED === "1")
			evaluation = await evaluationRunForTask(owner.userId, owner.id);
		const variant = await turnHarnessVariant(turn.id, owner.userId);
		const apiSettings: ApiTurnSettings = subscription
			? {}
			: (route.settings ?? {});
		// The subscription endpoint rejects the public Responses apply_patch tool;
		// it gets native Codex's freeform apply_patch (Lark grammar) instead.
		let nativePatch = false;
		const freeformPatch = !!subscription;
		// The provider's hosted web search, on a Codex subscription or a direct
		// connection to an official endpoint.
		let webSearch: ToolSet = {};
		if (subscription) {
			if (route.connectionId || !(await checkingCodexAuth))
				throw new Error("Reconnect Codex before continuing.");
			warmCodexSubscriptionCatalog(turn.user_id);
			// ChatGPT's Codex endpoint accepts the same hosted search as the OpenAI API.
			webSearch = nativeWebSearchTools("openai");
		} else {
			if (!route.connectionId) throw new Error("Model connection was removed.");
			const connection = await loadModelConnection(
				turn.user_id,
				route.connectionId,
			);
			if (connection?.revision !== route.connectionRevision)
				throw new Error(
					"The API connection changed after this turn was submitted.",
				);
			nativePatch =
				connection.provider === "openai" &&
				connection.baseUrl.startsWith("https://api.openai.com/");
			if (officialProviderEndpoint(connection))
				webSearch = nativeWebSearchTools(connection.provider);
		}
		failoverScope = {
			evaluation: Boolean(evaluation),
			child: Boolean(owner.parentSessionId),
			runtime: owner.harness === "codex" ? "codex" : "api",
			role: analyticsAgentRole(owner),
		};
		// The root chat is the builder itself; writable children build too.
		const writable =
			!owner.parentSessionId || owner.taskAccess === "read_write";
		// Cross-chat memory (Agent Memory Repo) for the root builder, never
		// benchmarks. Loaded alongside the rest of the setup; never fails a turn.
		const memoryLoading =
			writable && !owner.parentSessionId && !evaluation
				? timed("turn:memory", () =>
						turnMemo(`${turn.id}:memory`, () =>
							turnMemory(
								{
									id: owner.id,
									userId: owner.userId,
									projectId: owner.projectId ?? null,
								},
								{
									wording: variant.memoryWording,
									writer: variant.memoryWriter,
								},
							),
						),
					).catch(() => null)
				: Promise.resolve(null);
		let memoryCloned: Promise<void> | undefined;
		// Turn-fixed configuration is loaded by the turn's first durable step and
		// reused by later steps in the same isolate (see turn-memo). It may change
		// between turns; within one, keeping it fixed also keeps the tools and the
		// system prompt byte-stable for provider prompt caching. A restarted or
		// evicted isolate (including a resumed step) simply loads it again.
		const { projectId } = owner;
		const projectSecrets = projectId
			? await timed("turn:secrets", () =>
					turnMemo(`${turn.id}:project-secrets`, () =>
						loadAgentProjectSecrets(owner.userId, projectId).catch(() => ({
							envFile: agentSecretsEnvFile([]),
							redact: [],
							names: [],
						})),
					),
				)
			: null;
		let secretsWritten: Promise<void> | undefined;
		let attachmentsWritten: Promise<void> | undefined;
		const prepareWorkspace = deferredApiTurnWorkspace(
			machines,
			owner,
			abort.signal,
			[],
			workspaceReuse,
		);
		let codePoint: Promise<void> | undefined;
		const workspace = async () => {
			execution = await timed("turn:workspace", prepareWorkspace);
			let secretsReady: Promise<void> | undefined;
			if (projectSecrets) {
				const { machines: vmMachines, vm } = execution;
				// The env file stays on the VM's disk across steps; a new VM gets it written.
				secretsWritten ??= turnMemo(
					`${turn.id}:project-secrets-written:${vm}`,
					() => writeAgentProjectSecrets(vmMachines, vm, projectSecrets),
				);
				// Written outside the repository, so it overlaps the attachments and
				// code point below; the workspace is returned only after all three.
				secretsReady = secretsWritten;
				secretsReady.catch(() => {});
			}
			attachmentsWritten ??= materializeMessageAttachments(
				execution.machines,
				execution.vm,
				owner.userId,
				owner.id,
				sessionAttachments(items),
			).catch((error) => {
				// A missing file surfaces when the agent opens it; other tools keep working.
				console.warn("Attached files could not be restored.", error);
			});
			// ~/memory is outside the repository, so it overlaps the code point.
			const ready = execution;
			const cloning = memoryLoading.then((memory) => {
				if (!memory) return;
				memoryCloned ??= memory.prepareVm(ready);
				return memoryCloned;
			});
			await attachmentsWritten;
			if (writable) {
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
			await secretsReady;
			await cloning;
			return execution;
		};
		machines = machinesForAgentSession(machines, owner);
		publishProgress = async (turnStatus) => {
			if (turnStatus === "running") {
				progress.offer(items);
				await progress.drain();
			}
		};
		// Durable steps start at 1; a resumed first step reuses the deduped notice.
		const firstStep = step ? step.index === 1 : !continued;
		// The first step's UserPromptSubmit check always prepares a writable
		// workspace before the model is called; start it now so the VM work
		// overlaps the remaining setup. It is the same memoized preparation, so a
		// failure still surfaces where the workspace is awaited.
		if (firstStep && writable) void workspace().catch(() => {});
		const running = timed(
			"turn:publishRunning",
			() => publishProgress?.("running") ?? Promise.resolve(),
		);
		// Awaited below; this only keeps an early failure from being unhandled.
		running.catch(() => {});
		const originalTools = apiAgentTools({
			machines,
			session: owner,
			workspace,
			turnId: turn.id,
			nativePatch,
			freeformPatch,
			toolCallPrefix: step ? `step-${step.index}:` : undefined,
			signal: abort.signal,
			writable,
			waitDeadlineAt: step?.waitDeadlineAt,
		});
		const hooks = harnessLifecycleHooks({
			workspace,
			turnId: turn.id,
			readOnly: !writable,
			continuationCount: () =>
				completedLifecycleContinuations(owner.id, turn.id),
			signal: abort.signal,
			// A pinned baseline never changes; an unpinned one is read again because
			// preparing the workspace may pin it.
			baseline: ({ cwd }) =>
				turnMemo(
					`${turn.id}:verification-baseline:${cwd}`,
					() => readVerificationBaseline(owner.userId, owner.id, cwd),
					(base) => base !== null,
				),
			configCache: (key, load) => turnMemo(`${turn.id}:${key}`, load),
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
		// Root chats with a person to approve: the agent decides when to plan.
		// Benchmarks and child agents have no one to approve, so they never plan.
		const planState = agentPlanState(items);
		const planLock =
			!owner.parentSessionId && !evaluation ? new PlanLock(planState) : null;
		// Writable builders get the validated shell surface.
		const shellBuilder = writable;
		const repositoryContext = automaticRepositoryContext({
			tools: originalTools,
			workspace,
			signal: abort.signal,
			// Builders get repository instructions as messages, like AGENTS.md in Codex.
			instructionMessages: shellBuilder
				? { turnStart: step ? step.index === 1 : !continued }
				: undefined,
			onEvent: async (event) => {
				items = applyApiProgress(items, turn.id, event);
				progress.offer(items);
			},
		});
		// The builder's tool surface (docs/builder-tool-surface.md): "current"
		// for everyone; a development eval user's harness variant may pick a
		// lean one (docs/parallel-evals.md).
		const surface = !shellBuilder
			? { tools: repositoryContext.tools, lean: undefined }
			: builderToolSurface({
					variant: variant.toolSurface,
					modelId: route.modelId,
					tools: repositoryContext.tools,
					lean: {
						workspace,
						sessionId: owner.id,
						turnId: turn.id,
						toolCallPrefix: step ? `step-${step.index}:` : undefined,
						signal: abort.signal,
						memo: (key, load) => turnMemo(`${turn.id}:${key}`, load),
					},
				});
		const surfaceTools = surface.tools;
		// A lean surface names the repository's absolute path in its system
		// prompt (Claude Code's tools take absolute paths). The first step
		// prepares the workspace before the model is called anyway; later steps
		// reuse the memo, so the prompt stays byte-stable for caching.
		const leanWorkingDirectory = surface.lean
			? await turnMemo(
					`${turn.id}:lean-working-directory`,
					async () => (await workspace()).cwd,
				)
			: undefined;
		// The user's remote MCP servers are called from here; credentials never reach the VM.
		// Connections are live HTTP clients bound to this step's request, so a
		// step that calls a tool connects again; the tool lists are reused. A
		// list with OAuth servers is re-read each step because a token refresh
		// rotates their record.
		const connecting = timed("turn:mcp", async () =>
			connectMcpTools(
				await Promise.all(
					(
						await turnMemo(
							`${turn.id}:mcp-servers`,
							() =>
								connectableMcpServers(owner.userId, owner.projectId ?? null),
							(servers) => servers.every((server) => server.auth !== "oauth"),
						)
					)
						// OAuth servers join once the user has signed in.
						.filter((server) => server.auth !== "oauth" || server.sealedOAuth)
						.map(async (server) => ({
							key: `${server.id}:${server.url}`,
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
				{
					signal: abort.signal,
					// The tool list is fixed for the turn, like plugins; a step
					// connects only to call a tool.
					listing: (key, load) =>
						turnMemo(`${turn.id}:mcp-listing:${key}`, load),
				},
			),
		);
		const loadingPlugins = timed("turn:plugins", () =>
			turnMemo(`${turn.id}:plugins`, () =>
				enabledPluginComponents(owner.userId, owner.projectId ?? null),
			),
		);
		// Independent loads run together; connected MCP clients are always
		// registered for closing, and failures surface in their original order.
		const [published, connected, loaded] = await Promise.allSettled([
			running,
			connecting,
			loadingPlugins,
		]);
		if (connected.status === "fulfilled") closeMcp = connected.value.close;
		if (published.status === "rejected") throw published.reason;
		if (connected.status === "rejected") throw connected.reason;
		if (loaded.status === "rejected") throw loaded.reason;
		const mcp = connected.value;
		const plugins = loaded.value;
		// Runtime notices name only tools this session was offered.
		const commandReader =
			surface.lean?.commandReader ??
			("read_command" in surfaceTools ? "read_command" : "continue_command");
		// Delegated-task context concerns only sessions with children. A session
		// without the task tools (the builder) cannot gain children mid-turn, so
		// its answer holds for the turn; one with them re-checks until it has one.
		const canDelegate = "create_task" in surfaceTools;
		const hasChildren = () =>
			turnMemo(
				`${turn.id}:has-children`,
				() => hasDelegatedTasks(owner.userId, owner.id),
				(present) => present || !canDelegate,
			);
		const tools = turnTools({
			surfaceTools,
			mcp,
			plugins,
			webSearch,
			hooks,
			planLock,
			projectSecrets,
		});
		if (planLock?.planning && firstStep)
			messages = withPlanModeNotice(
				messages,
				planState.kind === "proposed"
					? PLAN_REVISION_NOTICE
					: PLAN_CONTINUE_NOTICE,
			);
		if (mcp.unavailable.length) {
			const notice = `MCP servers unavailable this turn (connection or credentials failed): ${mcp.unavailable.join(", ")}. Their tools are not offered; continue without them.`;
			if (!messages.some((message) => message.content === notice))
				messages = [...messages, { role: "user", content: notice }];
		}
		// Memory rides on the current request as extra parts, so earlier
		// messages and the system prompt stay byte-stable for prompt caching.
		const memory = await memoryLoading;
		if (memory && firstStep) {
			const attached = await timed("turn:memoryAttach", () =>
				memory.attach(messages, items, workspace),
			);
			messages = attached.messages;
			// The chat shows what was recalled; the model sees only the parts above.
			if (attached.recall) {
				items = withMemoryRecall(items, attached.recall);
				progress.offer(items);
			}
		}
		const projectKnowledge = shellBuilder
			? null
			: await loadCloudProjectKnowledge(
					owner,
					currentTask?.kind === "userMessage"
						? currentTask.text
						: (owner.taskPrompt ?? owner.title),
				);
		let flushedAt = 0;
		let metricIndex = 0;
		failureStage = "model";
		// Every root chat and child task works on the implementation surface.
		const toolSurface = "implementation";
		if (step && (step.limitReached || step.index > modelStepLimit(toolSurface)))
			throw new IncompleteAgentTurn("tool-calls");
		// Once per turn, before its first model request; a resumed first step reuses the journal.
		if (firstStep) {
			const submitted = await timed("turn:promptHook", () =>
				hooks.userPromptSubmit(
					currentTask?.kind === "userMessage" ? currentTask.text : "",
				),
			);
			if (submitted.block) throw new LifecycleHookRefusal(submitted.reason);
			// The journaled hook replays its feedback; an interrupted attempt may have saved it already.
			if (step?.resumed) {
				const saved = messages;
				messages = [
					...saved,
					...hooks
						.drain(saved)
						.slice(saved.length)
						.filter(
							(notice) =>
								!saved.some(
									(message) =>
										message.role === "user" &&
										message.content === notice.content,
								),
						),
				];
			}
		}
		const runAgent = subscription
			? step
				? runCodexSubscriptionAgentStep
				: runCodexSubscriptionAgent
			: (input: Parameters<typeof runCodexSubscriptionAgent>[0]) =>
					(step ? runApiAgentStep : runApiAgent)({
						...input,
						connectionId: route.connectionId as string,
					});
		const previousContext = recordedContextUsage(items)?.context;
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
			connectionId: route.connectionId ?? undefined,
			connectionRevision: route.connectionRevision,
			reasoning: subscription?.reasoning ?? apiSettings.reasoning,
			speed: apiSettings.speed,
			knownTools: discoveredToolsFromSession(items),
			toolSurface,
			...(planLock
				? {
						endTurnTools: [
							...PLAN_END_TURN_TOOLS,
							...SECRET_REQUEST_END_TURN_TOOLS,
						],
					}
				: {}),
			onToolMetric: (metric) => {
				recordStepTiming(`tool:${metric.tool_name}`, metric.duration_ms);
				void captureServerAnalytics(
					owner.userId,
					"harness_tool_completed",
					{
						...metric,
						runtime: owner.harness,
						role: analyticsAgentRole(owner),
						model_key: createHash("sha256").update(route.modelId).digest("hex"),
					},
					{
						key: `${turn.id}:${step?.index ?? 0}:tool-${metricIndex++}`,
						timestamp: new Date(),
					},
				);
			},
			onModelMetric: (metric) => {
				recordStepTiming("model:total", metric.duration_ms);
				if (metric.first_output_ms !== null)
					recordStepTiming("model:firstOutput", metric.first_output_ms);
				void captureServerAnalytics(
					owner.userId,
					"harness_model_completed",
					{
						...metric,
						runtime: owner.harness,
						role: analyticsAgentRole(owner),
						model_key: createHash("sha256").update(route.modelId).digest("hex"),
					},
					{
						key: `${turn.id}:${step?.index ?? 0}:model-${metricIndex++}`,
						timestamp: new Date(),
					},
				);
			},
			fast: subscription?.fast,
			modelId: route.modelId,
			onAttemptFailed: (state) => {
				failedAttempt = state;
			},
			messages,
			archiveHistory: async (history) => {
				const reference = await archiveModelContext(
					owner.userId,
					owner.id,
					history,
				);
				// A lean surface has no archive tools: it searches a file instead.
				const file = await surface.lean?.saveHistory(reference, history);
				return file ? { file } : reference;
			},
			instructions: turnInstructions(
				{
					shellBuilder,
					session: owner,
					tools,
					plugins,
					projectKnowledge,
					secretNames: projectSecrets?.names,
					leanShape: surface.lean?.shape,
					leanWorkingDirectory,
				},
				memory,
			),
			tools,
			signal: abort.signal,
			isUserRequest: (message) => isUserRequestMessage(items, message),
			compactionSnapshot: compactionStateSnapshot({
				workspace,
				baseRef: async () => {
					const first = items.find((item) => item.kind === "userMessage");
					return first && writable
						? conversationPointCodeRef(owner.userId, owner.id, first.id)
						: undefined;
				},
				runningIds: () => pendingAgentCommandIds(items),
			}),
			restoreInstructions: async (history) => {
				history = await repositoryContext.restoreInstructions(history);
				await hooks.postCompact(history);
				return hooks.drain(history);
			},
			afterTools: async (history) =>
				hooks.drain(await repositoryContext.afterTools(history)),
			prepareMessages: async (history) => {
				history = hooks.drain(await repositoryContext.prepare(history));
				history = await withBackgroundCommandContext({
					workspace,
					sessionId: owner.id,
					items,
					messages: history,
					signal: abort.signal,
					commandReader,
					checkpoint: async (injected) => {
						messages = injected;
						await saveCheckpoint();
						await publishProgress?.("running");
					},
				});
				const delegated = await hasChildren();
				let current = delegated
					? await withDelegationContext(owner.userId, owner.id, history)
					: history;
				if (delegated && !owner.parentSessionId && owner.projectId) {
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
				if (step && event.type === "retract")
					event = {
						...event,
						ids: event.ids.map((id) => `step-${step.index}:${id}`),
					};
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
		};
		if (
			forcedDevelopmentOutage(
				process.env,
				routeConnectionKey(route),
				step?.index ?? 1,
			)
		)
			throw new SafeApiModelFailure(developmentOutageError());
		let result: Awaited<ReturnType<typeof runAgent>> = await timed(
			"turn:runAgent",
			async () => runAgent(agentInput),
		);
		while (!step && (await hooks.stop(messages))) {
			messages = hooks.drain(messages);
			await saveCheckpoint();
			result = await runAgent({ ...agentInput, messages });
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
			commandReader,
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
								content: `Execution completion gate: these owned background commands are still running: ${JSON.stringify(pendingCommands)}. ${surface.lean ? surface.lean.waitHint(pendingCommands) : `Use ${"wait_command" in surfaceTools ? "wait_command" : "continue_command"} to wait for them`} and inspect their output; do not finalize or claim passing checks until they settle. This is runtime status, not a new user request.`,
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
			!items.slice(lastUser + 1).some(
				(item) =>
					(item.kind === "agentMessage" && item.text.trim()) ||
					// A proposed plan or a secret request is the turn's result; it waits for the user.
					item.kind === "planProposal" ||
					item.kind === "secretRequest",
			)
		)
			throw new IncompleteAgentTurn("missing-final-result");
		// What the agent committed to ~/memory this turn, shown after its answer.
		if (memory)
			items = await timed("turn:memorySaved", () =>
				memory.recordSaved(items, turn.id),
			);
		failureStage = "commit";
		// Fence even commands whose acknowledgement was lost before it reached the durable cards.
		// Unlike best-effort cancellation on failure, publication requires a confirmed stop.
		if (execution)
			await timed("turn:stopCommands", () =>
				stopApiTurnCommands(execution as AgentToolWorkspace, turn.id),
			);
		await timed("turn:commit", () =>
			commitCompletedSessionTurn(
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
			),
		);
		abort.signal.throwIfAborted();
		failureStage = "coordination";
		if (!(await coordinateConversationTurn("release", control)))
			throw new Error(
				"Conversation coordination lease was lost before completion.",
			);
		coordinated = false;
		failureStage = "saving";
		workspaceReuse?.forget();
		await progress.drain();
		const saved = await timed("turn:finalize", () =>
			finalizeApiTurn(turn, "completed", items),
		);
		if (saved !== "completed") {
			abort.abort();
			return saved === "cancelled" ? "cancelled" : "failed";
		}
		await publishProgress("completed").catch(() => {});
		await memory?.afterTurn(turn.id);
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
		workspaceReuse?.forget();
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
		// A provider-side failure moves the turn to its next best route; the
		// switch happens here, between model steps, never inside a stream.
		const reason =
			failureStage === "model" &&
			failoverScope &&
			!abort.signal.aborted &&
			!progressFailed &&
			!coordinationFailure
				? failoverReason(error)
				: null;
		let paused: ModelSwitchItem | undefined;
		let exhausted = "";
		if (reason && failoverScope) {
			const scope = failoverScope;
			try {
				const plan = await planModelFailover({
					turn,
					evaluation: scope.evaluation,
					child: scope.child,
					allowCustom: !step,
				});
				const { decision } = plan;
				const analytics = (
					outcome: "switched" | "asked" | "exhausted",
					sameModel: boolean,
					toPaid: boolean,
				) =>
					void captureServerAnalytics(
						turn.user_id,
						"model_failover",
						{
							runtime: scope.runtime,
							role: scope.role,
							reason,
							outcome,
							same_model: sameModel,
							to_paid: toPaid,
						},
						{
							key: `${turn.id}:failover-${plan.previous?.switches ?? 0}`,
							timestamp: new Date(),
						},
					);
				if (decision.kind === "switch") {
					const next = nextTurnFailover(
						plan.previous,
						plan.failing,
						decision.candidate,
					);
					// The failed step's cut-off text is not part of the answer.
					const partial = failedAttempt?.uncommittedIds ?? [];
					if (partial.length)
						items = applyApiProgress(items, turn.id, {
							type: "retract",
							ids: step
								? partial.map((id) => `step-${step.index}:${id}`)
								: [...partial],
						});
					items = [
						...items,
						modelSwitchItem(items, {
							id: `${turn.id}:switch-${next.switches}`,
							state: "switched",
							message: failoverNotice(plan.failing.label, next.label, reason),
							reason,
							from: plan.failing.label,
							to: { ...next.label, key: routeKey(next.route) },
						}),
					];
					messages = modelSwitchHistory(
						failedAttempt?.droppedStepSaved
							? failedAttempt.committed
							: messages,
						failoverRuntimeNote(plan.failing.label, next.label, reason),
					);
					await checkpointApiTurn(turn, messages, items, next);
					analytics(
						"switched",
						decision.candidate.sameModel,
						decision.candidate.paid,
					);
					// The turn's lease carries over to the step on the fallback.
					coordinated = false;
					return { failedOver: { ...turn, failover: next, messages, items } };
				}
				if (decision.kind === "ask") {
					const to = {
						model: decision.candidate.modelLabel,
						connection: decision.candidate.connectionLabel,
					};
					paused = modelSwitchItem(items, {
						id: `${turn.id}:error`,
						state: "awaitingApproval",
						message: failoverQuestion(plan.failing.label, to, reason),
						reason,
						from: plan.failing.label,
						to: { ...to, key: routeKey(decision.candidate.route) },
					});
					analytics("asked", decision.candidate.sameModel, true);
				} else if (plan.previous) {
					// The failing route is the last one the turn moved to, already tried.
					exhausted = failoverExhaustedDetail(plan.previous);
					analytics("exhausted", false, false);
				}
			} catch (cause) {
				console.warn("Model failover failed", {
					...apiTurnFailureClassification(cause),
				});
			}
		}
		const failureMessage = progressFailed
			? "Turn progress could not be saved. Inspect the task before retrying."
			: coordinationFailure
				? apiTurnFailureMessage("coordination", coordinationFailure)
				: abort.signal.reason instanceof TurnTimeLimitReached
					? TURN_TIME_LIMIT_MESSAGE
					: abort.signal.aborted
						? `Run stopped. ${abort.signal.reason instanceof Error && ["Turn ownership or cancellation state changed.", "Conversation coordination lease was lost.", "Turn heartbeat or coordination service became unavailable."].includes(abort.signal.reason.message) ? `${abort.signal.reason.message} ` : ""}Inspect any in-flight command before continuing.`
						: exhausted
							? apiTurnFailureMessage(failureStage, error).replace(
									" No fallback was used.",
									"",
								) +
								exhausted +
								developmentFailureDetail(error)
							: (paused?.message ??
									apiTurnFailureMessage(failureStage, error)) +
								developmentFailureDetail(error);
		// The heartbeat or the room usually notices the user's Stop before progress does.
		const userCancelled =
			abort.signal.reason instanceof ApiTurnCancelled ||
			(abort.signal.aborted &&
				(await apiTurnCancelRequested(turn).catch(() => false)));
		if (!userCancelled)
			items = [
				...items,
				paused ?? {
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
		// A turn out of time failed, not stopped: the user and a parent agent both hear why.
		const timedOut = abort.signal.reason instanceof TurnTimeLimitReached;
		const saved = await finalizeApiTurn(
			turn,
			userCancelled ||
				(abort.signal.aborted &&
					!timedOut &&
					!heartbeatFailed &&
					!progressFailed)
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

/** A transcript notice of a switch (or a paused one); usage so far stays with the first route. */
/**
 * Development eval users pick harness variants per run; everyone else (and
 * production) gets the default. Fixed for the turn.
 */
function turnHarnessVariant(turnId: string, userId: string) {
	return devEvalUsersEnabled()
		? turnMemo(`${turnId}:harness-variant`, () => harnessVariantForUser(userId))
		: Promise.resolve(DEFAULT_HARNESS_VARIANT);
}

/**
 * The tools a turn offers: its surface's tools, the user's MCP servers,
 * plugin skills and hosted web search, wrapped in lifecycle hooks, secret
 * redaction and (in root chats) plan mode.
 */
function turnTools(input: {
	surfaceTools: ToolSet;
	mcp: Awaited<ReturnType<typeof connectMcpTools>>;
	plugins: Awaited<ReturnType<typeof enabledPluginComponents>>;
	webSearch: ToolSet;
	hooks: ReturnType<typeof harnessLifecycleHooks>;
	planLock: PlanLock | null;
	projectSecrets: Awaited<ReturnType<typeof loadAgentProjectSecrets>> | null;
}) {
	const { mcp, hooks, planLock, projectSecrets } = input;
	const withMcp = {
		...input.surfaceTools,
		...mcp.tools,
		...pluginSkillTools(input.plugins),
		...input.webSearch,
	};
	const redact = projectSecrets?.redact ?? [];
	// Only a person in a root chat can paste a secret into the card.
	const secretTools =
		planLock && projectSecrets
			? secretRequestTools(projectSecrets.names.map(({ name }) => name))
			: {};
	// Large MCP setups are searched and called through two fixed tools; the
	// real tools they run keep their hooks, plan mode and redaction.
	return mcpToolSurface({
		tools: planLock
			? withPlanMode(
					hooks.wrap(
						withRedactedResults(
							{ ...withMcp, ...planTools(planLock), ...secretTools },
							redact,
						),
					),
					() => planLock.planning,
				)
			: hooks.wrap(withRedactedResults(withMcp, redact)),
		catalog: mcp.catalog,
		purposes: mcp.purposes,
	});
}

/** The system prompt: the builder's instructions, then memory's. */
function turnInstructions(
	agent: Parameters<typeof agentTurnInstructions>[0],
	memory: { instructions: string } | null,
) {
	return `${agentTurnInstructions(agent)}${memory ? `\n${memory.instructions}` : ""}`;
}

function modelSwitchItem(
	items: readonly SessionItem[],
	input: {
		id: string;
		state: ModelSwitchItem["state"];
		message: string;
		reason: FailoverReason;
		from: ModelSwitchItem["from"];
		to: ModelSwitchItem["to"];
	},
): ModelSwitchItem {
	const usageBefore = [...items]
		.reverse()
		.find((item) => item.kind === "userMessage")?.apiUsage;
	return {
		kind: "modelSwitch",
		...input,
		id: SessionItemId(input.id),
		...(usageBefore ? { usageBefore } : {}),
	};
}

const TURN_TIME_LIMIT_MESSAGE =
	"This turn reached its time limit and was stopped. Work so far is preserved; inspect any in-flight command, then send a message to continue.";

class TurnTimeLimitReached extends Error {
	constructor() {
		super("Turn time limit reached.");
		this.name = "TurnTimeLimitReached";
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
