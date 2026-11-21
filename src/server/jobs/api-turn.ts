import { createHash } from "node:crypto";
import type { ModelMessage, ToolSet } from "ai";
import { boundActiveTurnItems } from "#/domain/active-turn-bound";
import { applyPlanUpdate } from "#/domain/agent-todos";
import {
	assertApiContextFits,
	isUserRequestMessage,
} from "#/domain/api-conversation";
import { applyApiProgress, recordedContextUsage } from "#/domain/api-progress";
import { type ApiTokenUsage, addApiTokenUsage } from "#/domain/api-token-usage";
import {
	ApiTurnCancelled,
	type ApiTurnFailureStage,
	apiTurnFailureClassification,
	apiTurnFailureMessage,
	ClaudeRunnerRequired,
	ClaudeRunnerTransportFailure,
	ClaudeSubscriptionRefused,
	failureCause,
	IncompleteAgentTurn,
	isYSquaredNoWorkspace,
	LifecycleHookRefusal,
	SafeApiModelFailure,
	Y_SQUARED_NO_WORKSPACE,
	YSquaredClaudeRunnerUnreachable,
} from "#/domain/api-turn-failure";
import type { ApiTurnSettings } from "#/domain/api-turn-settings";
import { attemptLimit } from "#/domain/attempt-loop";
import {
	CHECKER_FORCED_FINAL_MARK,
	hasCheckerFinalNotice,
} from "#/domain/checker-brief";
import { latestUserRequestText } from "#/domain/child-task-activity";
import { claudeBoxToolsEnabled } from "#/domain/claude-box-tools";
import {
	claudeSubscriptionEnabled,
	isClaudeCodeRevision,
} from "#/domain/claude-code-route";
import { type ClaudeRunnerBox, claudeRunnerFor } from "#/domain/claude-runner";
import {
	CoordinationFailure,
	TURN_COORDINATION_LEASE_MS,
	type TurnControl,
} from "#/domain/conversation-turn-control";
import { isDevelopmentEnvironment } from "#/domain/development-environment";
import { SETUP_CAUGHT_UP_NOTICE } from "#/domain/fresh-machine-setup";
import { fusionPairFor } from "#/domain/fusion-pairs";
import { nextGoalStep } from "#/domain/goal";
import {
	goalNoticeItem,
	goalOfTurn,
	turnToolCards,
	withGoalNotice,
} from "#/domain/goal-notice";
import {
	type HarnessVariant,
	leadReasoningEffort,
	outputCapCharacters,
	PRODUCT_HARNESS_VARIANT,
	promptCacheScopeId,
} from "#/domain/harness-variant";
import { SessionItemId, WorkspaceId } from "#/domain/ids";
import { prepareInterruptedStep } from "#/domain/interrupted-step";
import { HANDOFF_HISTORY_INSTRUCTIONS } from "#/domain/local-import";
import { withMemoryRecall } from "#/domain/memory-marker";
import { officialProviderEndpoint } from "#/domain/model-connection";
import {
	failoverChainFailure,
	failoverExhaustedDetail,
	failoverNotice,
	failoverQuestion,
	failoverRuntimeNote,
	forcedDevelopmentOutage,
	MODEL_STEP_RETRY_DELAYS_MS,
	nextTurnFailover,
	routeConnectionKey,
	routeKey,
	routeRetries,
	servingRoute,
	turnFailover,
	withRouteRetries,
} from "#/domain/model-failover";
import {
	developmentOutageError,
	failoverReason,
	failureSummary,
	fallbackAccountReason,
	retriesSameRoute,
	subscriptionLimitResetsAt,
} from "#/domain/model-failover-reason";
import { modelBilling } from "#/domain/model-pricing";
import { modelStepLimit } from "#/domain/model-workflow";
import { posixShellCommand, posixShellQuoted } from "#/domain/posix-command";
import {
	agentSecretsEnvFile,
	SOURCE_AGENT_SECRETS,
	sessionReceivesProjectSecrets,
} from "#/domain/project-secret";
import { publicFailureMessage } from "#/domain/project-workspace";
import {
	openedPullRequestItem,
	openingPullRequestItem,
	pullRequestHandoffItemId,
} from "#/domain/pull-request-handoff-item";
import { REQUEST_PUSH_APPROVAL_TOOL } from "#/domain/push-approval";
import type { RoleModels } from "#/domain/role-models";
import { modelSwitchHistory } from "#/domain/runtime-handoff";
import { REQUEST_PROJECT_SECRET_TOOL } from "#/domain/secret-request";
import type {
	ModelSwitchItem,
	SessionItem,
	UserMessageItem,
} from "#/domain/session-item";
import { isSideChat, sideChatReadOnly } from "#/domain/side-chat";
import { chatWaitingOn } from "#/domain/sidebar-chats";
import {
	isActiveSidekick,
	sidekickState,
	sidekickSwitchDue,
} from "#/domain/sidekick";
import {
	AGENT_SEND_TOOL,
	AGENT_TOOL,
	isReaderRole,
	MAX_SUBAGENT_LEVEL,
	writesOwnCheckout,
} from "#/domain/subagent";
import { subscriptionTurnSettings } from "#/domain/subscription-turn";
import { withStoppedNotice } from "#/domain/turn-end";
import {
	savingChangesItem,
	turnMayHaveChangedWorkspace,
	withoutSavingChanges,
} from "#/domain/turn-saving";
import { hubTopic } from "#/domain/user-hub";
import { ASK_USER_TOOL } from "#/domain/user-question";
import { ySquaredInstructions } from "#/domain/y-squared";
import { ySquaredModelMessages } from "#/domain/y-squared-images";
import { apiReasoningEffort } from "#/server/adapters/api-reasoning-effort";
import { isPlatformRestart } from "#/server/adapters/freestyle/provider-retry";
import { lastUserMessageIndex } from "#/server/adapters/turn-items-storage";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import type { ApiTurn } from "../adapters/api-turns";
import { savedCanvasRevision } from "../adapters/canvas-revisions";
import { devEvalUsersEnabled } from "../adapters/dev-eval-users";
import type { EvaluationRun } from "../adapters/harness-evaluation";
import type { ImportedSessionRow } from "../adapters/local-imports";
import { nativeWebSearchTools } from "../adapters/native-web-search";
import { queuedMessageSentNow } from "../adapters/peer-inbox-observation";
import { nodePublicHost } from "../adapters/public-host";
import {
	agentCapturesNote,
	collectAgentCaptures,
} from "../services/agent-captures";
import { withMentionNote } from "../services/agent-mentions";
import type { AgentToolWorkspace } from "../services/agent-tool-workspace";
import { agentTurnInstructions } from "../services/agent-turn-instructions";
import { runApiAgent, runApiAgentStep } from "../services/api-agent-runtime";
import { apiAgentTools } from "../services/api-agent-tools";
import { stopApiTurnCommands } from "../services/api-command-scope";
import type { deferredApiTurnWorkspace } from "../services/api-turn-workspace";
import {
	ASK_USER_END_TURN_TOOLS,
	askUserTools,
} from "../services/ask-user-tool";
import { createAttemptLoop } from "../services/attempt-loop";
import { attemptLoopDeps, reviewLoopDeps } from "../services/attempt-loop-deps";
import { automaticRepositoryContext } from "../services/automatic-repository-context";
import {
	pendingAgentCommandIds,
	withBackgroundCommandContext,
} from "../services/background-command-context";
import { withBackgroundCommandNotices } from "../services/background-command-notices";
import { settleIdleTimeoutAfterTurn } from "../services/background-idle-timeout";
import {
	builderToolSurface,
	leanSurfaceToolNames,
} from "../services/builder-shell-surface";
import { canvasTools } from "../services/canvas-tool";
import { checkerPairGate } from "../services/checker-pair-gate";
import {
	type BoxToolIdentityStore,
	releaseClaudeBoxToolIdentity,
} from "../services/claude-box-tool-grant";
import {
	claudeCodeBridgeToolSet,
	claudeCodeSentMessagesText,
	leavesClaudeCodeRunning,
	runClaudeCodeTurnStep,
	stopClaudeCodeTurnRun,
	withMessagesSentDuringRun,
} from "../services/claude-code-turn";
import { noteClaudeTurnQuiet } from "../services/claude-step-pause";
import {
	CODE_MODE_TOOL,
	codeModeTool,
	primaryCodeModeTools,
} from "../services/code-mode-tool";
import {
	runCodexSubscriptionAgent,
	runCodexSubscriptionAgentStep,
} from "../services/codex-subscription-agent";
import {
	endsWithCompactCommand,
	withCompactInstruction,
} from "../services/compact-command";
import { compactionStateSnapshot } from "../services/compaction-state-snapshot";
import {
	CODE_MODE_DEFERRED_TOOLS,
	deferredToolSurface,
	loadedDeferredTools,
} from "../services/deferred-tools";
import { describeSecretTools } from "../services/describe-secret-tool";
import { environmentSetupTools } from "../services/environment-setup-tool";
import {
	FIRST_REQUEST_WORKSPACE_WAIT_MS,
	type PromptCheck,
	settlesWithin,
	withPromptCheckGate,
} from "../services/first-request-gate";
import { withSetupCatchUp } from "../services/fresh-machine-setup";
import {
	type FusionLeadGateInput,
	fusionLeadGate,
	leadWriteTracker,
	withSidekickWriteGuard,
} from "../services/fusion-lead";
import { goalTool } from "../services/goal-tool";
import { materializeHandoffHistory } from "../services/handoff-history";
import {
	harnessLifecycleHooks,
	LIFECYCLE_CONFIG_PATH,
	lifecycleConfigFromFile,
	lifecycleHookConfig,
} from "../services/harness-lifecycle-hooks";
import { journaledToolOperation } from "../services/journaled-tool-operation";
import { registerLiveTurn } from "../services/live-turn-abort";
import { cancellableMachines } from "../services/machine-call-signal";
import { type MachineGitStep, machineGitStep } from "../services/machine-git";
import { turnOAuthProvider } from "../services/mcp-oauth";
import { mcpToolSurface } from "../services/mcp-tool-surface";
import { connectMcpTools } from "../services/mcp-tools";
import {
	materializeMessageAttachments,
	sessionAttachments,
} from "../services/message-attachments";
import {
	type ModelAgentInput,
	ModelSwitchAtCompaction,
} from "../services/model-agent-loop";
import { planModelFailover } from "../services/model-failover";
import { modelRequestRecorder } from "../services/model-request-recorder";
import { planTool } from "../services/plan-tool";
import { pluginSkillTools } from "../services/plugin-skill-tools";
import {
	countCommitsCommand,
	pushApprovalTools,
} from "../services/push-approval-tool";
import { withRedactedResults } from "../services/redacted-tools";
import { hasRepositoryInstructions } from "../services/repository-instructions";
import { createReviewLoop } from "../services/review-loop";
import { saveProjectSecretTools } from "../services/save-project-secret-tool";
import {
	SECRET_REQUEST_END_TURN_TOOLS,
	secretRequestTools,
} from "../services/secret-request-tool";
import { machinesForAgentSession } from "../services/session-workspace-machines";
import {
	blockSidekickSwitch,
	completeSidekickModelSwitch,
	sidekickSwitchAllowed,
	sidekickSwitchAtCompaction,
} from "../services/sidekick-model-switch";
import { recordStepTiming, timed } from "../services/step-timing";
import {
	guardSubagentStep,
	retireLeadSidekicks,
	SubagentBudgetExhausted,
	subagentReport,
} from "../services/subagent-runtime";
import {
	checkerWorkerTools,
	type SubagentToolContext,
	subagentTools,
} from "../services/subagent-tools";
import { thinLeadTools } from "../services/thin-lead-tools";
import {
	pauseVmWhileThinkingEnabled,
	resumingAfterThinkingPause,
	type ThinkingPauseScheduler,
	thinkingPauseScheduler,
} from "../services/thinking-pause";
import { withOutputCap } from "../services/tool-output-cap";
import { analyticsAgentRole } from "../services/turn-analytics";
import type { CommittedTurn, PublishedTurn } from "../services/turn-commit";
import { forgetTurnMemo, setTurnMemo, turnMemo } from "../services/turn-memo";
import type { TurnMemory } from "../services/turn-memory";
import { turnProgressWriter } from "../services/turn-progress-writer";
import {
	type EarlyRequestReason,
	type TurnTiming,
	turnSpan,
	turnTiming,
	withTurnTimingMarks,
} from "../services/turn-timing";
import { type TurnToolTime, turnToolTime } from "../services/turn-tool-time";
import { turnWorkspaceReuse } from "../services/turn-workspace-reuse";
import { webFetchTool } from "../services/web-fetch-tool";
import type { WorkspaceMachines } from "../services/workspace-machines";
import {
	withWorkspaceNote,
	workspaceReplacedNote,
} from "../services/workspace-replaced-note";
import { ySquaredTools } from "../services/y-squared-tools";
import { yTools } from "../services/y-tools";

import type { TurnPorts } from "./turn-ports";

/**
 * Acquires the chat's coordination lease, waiting out a brief holder instead
 * of failing: a code restore holds the lease until just before it commits, and
 * a hold whose release failed lapses within one lease period. A turn that was
 * stopped meanwhile ends the wait through its heartbeat's abort.
 */
async function acquireConversationTurn(
	control: TurnControl,
	signal: AbortSignal,
	coordinateConversationTurn: TurnPorts["coordinateConversationTurn"],
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
	/**
	 * Epoch ms after which a step still waiting on its model call, with no tool
	 * started, ends cleanly and continues in the next step (the hard abort at the
	 * step budget stays as the last resort).
	 */
	softDeadlineAt?: number;
	/** The same step is being re-run after its executor restarted mid-step. */
	resumed?: boolean;
	/** Epoch ms the executor started this step (its claim), for its timing line. */
	startedAt?: number;
};

/**
 * Step mode is for the external durable orchestrator; the default preserves
 * the local worker. A turn that failed over keeps its lease: in step mode its
 * next step runs on the fallback; the local worker continues it here.
 */
/**
 * Pushes a done turn's branch and opens or updates its draft pull request,
 * then replaces its "Opening pull request…" item: with the pull request's
 * link, with why the changes were not pushed, or (nothing reached a pull
 * request) with nothing. GitHub trouble never fails the turn.
 */
export async function finishPullRequestHandoff(
	turn: Pick<ApiTurn, "id" | "session_id" | "user_id">,
	publish: NonNullable<CommittedTurn["publish"]>,
	replaceSettledTurnItem: TurnPorts["replaceSettledTurnItem"],
) {
	const id = pullRequestHandoffItemId(turn.id);
	const show = (item: SessionItem | null) =>
		replaceSettledTurnItem(turn, id, item).catch((error) => {
			console.warn("The pull request handoff could not be shown in the chat.", {
				message:
					error instanceof Error ? error.message.slice(0, 300) : "unknown",
			});
			return false;
		});
	// The link reaches the chat the moment GitHub returns the pull request.
	let shown: Promise<boolean> | undefined;
	const outcome = await publish((pull) => {
		shown = show(openedPullRequestItem(turn.id, pull));
		return shown;
	}).catch(
		(error: unknown): PublishedTurn => ({
			failure: `Changes are committed in this chat but were not pushed: ${publicFailureMessage(error) || "GitHub did not accept the push."}`,
		}),
	);
	if (shown && !outcome.failure && outcome.publication?.pullRequest) return;
	await show(
		outcome.failure
			? { kind: "notice", id, message: outcome.failure }
			: openedPullRequestItem(turn.id, outcome.publication?.pullRequest),
	);
}

/**
 * A chat's turn ended: helper reports and other notices held while it ran
 * are delivered now (after any queued user message's turn, which holds
 * them again until it ends).
 */
async function deliverHeldReports(
	sessionId: string,
	parentSessionId: string | null | undefined,
	ports: Pick<
		TurnPorts,
		"releaseHeldAgentTaskEvents" | "enqueueAgentTaskEvent"
	>,
) {
	if (parentSessionId) return;
	try {
		if (await ports.releaseHeldAgentTaskEvents(sessionId))
			await ports.enqueueAgentTaskEvent();
	} catch {
		// The task-event sweep delivers them once their retry is due.
	}
}

const MCP_UNAVAILABLE_PREFIX =
	"MCP servers unavailable this turn (connection or credentials failed):";

export async function runApiTurn(
	machines: WorkspaceMachines,
	turn: ApiTurn,
	step?: ApiTurnStep,
	/**
	 * Unset in the Durable Object and the Node worker: the database-backed
	 * `localTurnPorts`, loaded on first use so a turn runner box (which always
	 * passes its own ports) never loads them or the database adapters under them.
	 */
	givenPorts?: TurnPorts,
): Promise<ApiTurnStepOutcome> {
	const ports =
		givenPorts ?? (await import("./turn-ports-local")).localTurnPorts;
	// A durable step logs where its time went (turn-timing.ts).
	const timing = step
		? turnTiming({
				turnId: turn.id,
				step: step.index,
				startedAt: step.startedAt ?? Date.now(),
				queuedAt: turn.queued_at_ms ?? undefined,
			})
		: undefined;
	// How much of the step tools were executing (turn-tool-time.ts).
	const toolTime = step
		? turnToolTime({
				turnId: turn.id,
				step: step.index,
				startedAt: step.startedAt ?? Date.now(),
			})
		: undefined;
	timing?.mark("turnStart");
	let ended = "error";
	try {
		// Bounded: every failover adds a route to the turn's tried set
		// (MAX_TURN_FAILOVERS); each route retries a failed step at most
		// MODEL_STEP_RETRY_DELAYS_MS.length times before a step succeeds.
		for (let continued = false; ; continued = true) {
			const attempt = () =>
				runApiTurnAttempt(
					machines,
					turn,
					step,
					continued,
					ports,
					timing,
					toolTime,
				);
			// Model and egress code below marks its own phases (request start,
			// response headers, first body byte, egress path).
			const outcome = await (timing
				? withTurnTimingMarks(
						(phase) => timing.mark(phase),
						attempt,
						(name, at, ms) => timing.span(name, at, ms),
					)
				: attempt());
			if (typeof outcome === "string") {
				if (outcome !== "continue") forgetTurnMemo(turn.id);
				ended = outcome;
				return outcome;
			}
			if (step) {
				ended = "failed-over";
				return "continue";
			}
			turn = outcome.failedOver;
		}
	} finally {
		timing?.write(ended);
		toolTime?.write(ended);
	}
}

async function runApiTurnAttempt(
	machines: WorkspaceMachines,
	turn: ApiTurn,
	step: ApiTurnStep | undefined,
	/** The local worker is continuing this turn on a fallback route. */
	continued: boolean,
	ports: TurnPorts,
	timing?: TurnTiming,
	toolTime?: TurnToolTime,
): Promise<ApiTurnStepOutcome | { failedOver: ApiTurn }> {
	const {
		renewApiTurn,
		checkpointApiTurn,
		publishApiTurnProgress,
		finalizeApiTurn,
		apiTurnCancelRequested,
		reserveApiTokens,
		replaceSettledTurnItem,
		otherRunningTurnOnMachine,
		turnBoxToolIdentity,
		recordTurnBoxToolIdentity,
		clearTurnBoxToolIdentity,
		coordinateConversationTurn,
		agentSessionMetadataForOwner,
		subagentAncestors,
		projectImportedSessions,
		projectYMode,
		loadModelConnection,
		completedLifecycleContinuations,
		conversationPointCodeRef,
		readVerificationBaseline,
		readPreparedCheckoutDirectory,
		savePreparedCheckoutDirectory,
		readProjectDerivedValue,
		readSessionDerivedValue,
		saveSessionDerivedValue,
		enabledPluginSkillIndex,
		pluginSkillBody,
		harnessVariantForUser,
		isDevEvalUser,
		connectableMcpServers,
		saveAgentTaskResultAndEvent,
		enqueueAgentTaskEvent,
		captureServerAnalytics,
		noteUserHub,
		noteCrewWaiting,
		injectServerPeerMessages,
		archiveModelContext,
		recordCloudProjectReport,
		evaluationRunForTask,
		assertEvaluationActive,
		recordEvaluationUsage,
		reserveEvaluationRequest,
		pinnedClaudeRunner,
		claudeSubscriptionStatus,
		warmCodexSubscriptionCatalog,
		hasManagedCodexAuth,
		loadAgentProjectSecrets,
		saveAccountWideSecret,
		saveVisibleProjectSecret,
		setSecretDescription,
		writeAgentProjectSecrets,
		startQueuedUserTurn,
		commitSessionTurn,
		ensureConversationCodePoint,
		deferredApiTurnWorkspace,
		turnMemory,
		subagentMemory,
		withPushResultNotices,
	} = ports;
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
	// Same-route retries of a failed step so far (kept with the turn's failover state).
	let retried = routeRetries(turn.failover, route);
	// Set once a model step succeeds after a retry: the next checkpoint clears the count.
	let retryCleared: ReturnType<typeof withRouteRetries> | undefined;
	let failoverScope:
		| {
				evaluation: boolean;
				child: boolean;
				runtime: "codex" | "api";
				role: ReturnType<typeof analyticsAgentRole>;
		  }
		| undefined;
	/** A Claude Code turn: stops its CLI when the turn moves to another model. */
	let stopClaudeCodeRun: (() => Promise<void>) | undefined;
	/**
	 * The Freestyle identity a Claude runner box uses for this turn's workspace
	 * tools (claude-box-tool-grant.ts), recorded on the turn row.
	 */
	const boxToolStore: BoxToolIdentityStore = {
		current: () => turnBoxToolIdentity(turn.id, turn.lease_id ?? null),
		record: (identityId) =>
			turn.lease_id
				? recordTurnBoxToolIdentity(turn.id, turn.lease_id, identityId)
				: Promise.resolve(false),
		clear: (identityId) => clearTurnBoxToolIdentity(turn.id, identityId),
	};
	/**
	 * Deletes that identity: at turn end, lease loss and failover. Only Claude
	 * Code turns with box tools on ask; the sweep covers the rest. Never throws.
	 */
	const releaseBoxTools = () =>
		stopClaudeCodeRun && claudeBoxToolsEnabled(process.env)
			? releaseClaudeBoxToolIdentity({
					machines: unscopedMachines,
					store: boxToolStore,
				})
			: Promise.resolve();
	let failedAttempt:
		| {
				committed: ModelMessage[];
				droppedStepSaved: boolean;
				uncommittedIds: readonly string[];
				inFlight?: ModelMessage[];
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
	// YTIMESY_PAUSE_VM_WHILE_THINKING: the VM may be paused between tool calls
	// (thinking-pause.ts), so every guest operation of this turn, its
	// subagents' and its cleanup's, first resumes a VM paused that way.
	const pausingWhileThinking = pauseVmWhileThinkingEnabled();
	const plainMachines = machines;
	if (pausingWhileThinking) machines = resumingAfterThinkingPause(machines);
	let thinkingPause: ThinkingPauseScheduler | undefined;
	// Subagents address the parent's and forks' VMs directly, so they get the
	// machines before this session's scoping; the report needs the session.
	const unscopedMachines = machines;
	// This turn's own workspace calls stop at once on Stop or a deadline, and
	// their provider requests are aborted; calls after the abort (stopping the
	// turn's commands, releasing ~/memory) still run. Subagents, the next
	// queued turn and other turns keep the plain machines.
	const turnMachines = cancellableMachines(machines, abort.signal);
	let queueMachines = machines;
	let subagentSession: AgentSessionRecord | undefined;
	/** A side chat's failure stays in its column; it does not report to Main. */
	let sideConversation = false;
	/** Lead mode fusion's root: its sidekicks are retired when its turn ends. */
	let fusionLead: { userId: string; id: string } | undefined;
	/** Lead mode fusion: the variant's role models (a sidekick's classifier and escalation model). */
	let fusionRoleModels: RoleModels | undefined;
	/** Lead mode fusion with leadTools=thin: a writer's notices point its lead to a restart. */
	let fusionThinLead = false;
	/** Harness variant y=on: a writer's patch is applied to its root's (Y's) checkout. */
	let yVariant = false;
	/** Lead mode fusion: the lead's writes in this step (a round started stops them). */
	const leadWrites = leadWriteTracker();
	let activeClaudeRunner: ClaudeRunnerBox | null = null;
	let commandStop: Promise<void> | undefined;
	const stopCommands = () => {
		// A deploy resumes the step, and a Claude Code turn's agent loop is its
		// process on the VM: let it run for the resumed step to re-attach to.
		if (
			stopClaudeCodeRun &&
			leavesClaudeCodeRunning([abort.signal.reason, step?.signal.reason])
		)
			return;
		if (execution || activeClaudeRunner)
			commandStop ??= Promise.all([
				execution ? stopApiTurnCommands(execution, turn.id) : undefined,
				activeClaudeRunner ? stopClaudeCodeRun?.() : undefined,
			])
				.then(() => undefined)
				.catch(() => {
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
	/**
	 * The turn is marked completed: its lease is no longer needed, and a
	 * renewal that fails because the row is no longer 'running' is expected.
	 * What follows (publication, the preparation wait, the next queued
	 * message) must not be aborted by it.
	 */
	let turnSettled = false;
	/** The turn passed its last stop check and is being marked done. */
	let finalizing = false;
	let heartbeatPending: Promise<void> | undefined;
	let coordinationHeartbeatPending: Promise<void> | undefined;
	let coordinationHeartbeatBusy = false;
	let heartbeatFailed = false;
	let coordinationFailure: CoordinationFailure | undefined;
	let progressFailed = false;
	// The soft deadline stops only the model call, and only before any tool has
	// started; it is not `abort`, whose listeners stop the turn's owned commands.
	const softStop = new AbortController();
	let toolsStarted = false;
	const softTimer =
		step?.softDeadlineAt === undefined
			? undefined
			: setTimeout(
					() => {
						if (!toolsStarted && !abort.signal.aborted)
							softStop.abort(new Error("Step soft deadline reached."));
					},
					Math.max(0, step.softDeadlineAt - Date.now()),
				);
	const progress = turnProgressWriter(
		(snapshot) => publishApiTurnProgress(turn, snapshot),
		(error) => {
			if (error instanceof ApiTurnCancelled) {
				abort.abort(error);
				return;
			}
			progressFailed = true;
			// The abort below replaces this error with a generic one; keep the real one in the log.
			console.warn("Turn progress write failed", {
				turnId: turn.id,
				platformRestart: isPlatformRestart(error),
				...apiTurnFailureClassification(error),
				message: (error instanceof Error ? error.message : String(error)).slice(
					0,
					300,
				),
			});
			// A Durable Object reset for new code surfaces here first (the write's
			// wake touches the object); the step must resume, so keep that error.
			abort.abort(
				isPlatformRestart(error)
					? error
					: new Error("Turn progress could not be saved."),
			);
		},
	);
	// History is replaced, never mutated, so an unchanged pair is already saved.
	let checkpointed:
		| { messages: ModelMessage[]; items: typeof items }
		| undefined;
	const saveCheckpoint = () =>
		timed("turn:checkpoint", async () => {
			// A long turn keeps recent tool output whole and older output as previews.
			const activeStart = turn.items_from
				? items.findIndex((item) => item.id === turn.items_from)
				: lastUserMessageIndex(items);
			items = boundActiveTurnItems(items, activeStart);
			const saved = () =>
				!retryCleared &&
				checkpointed?.messages === messages &&
				checkpointed.items === items;
			// The checkpoint writes the newest items, so a snapshot still waiting
			// to be written would only cost a write (and a relay) before it.
			if (!saved()) progress.supersede();
			await progress.drain();
			if (saved()) return;
			const saving = { messages, items };
			const clearing = retryCleared;
			await (clearing
				? checkpointApiTurn(turn, saving.messages, saving.items, clearing)
				: checkpointApiTurn(turn, saving.messages, saving.items));
			checkpointed = saving;
			progress.markStored(saving.items);
			if (clearing === retryCleared) retryCleared = undefined;
		});
	let failureStage: ApiTurnFailureStage = "connection";
	const control = {
		userId: turn.user_id,
		sessionId: turn.session_id,
		turnId: turn.id,
		leaseId: turn.lease_id as string,
	};
	let coordinated = false;
	/**
	 * The step returned with the lease carried to the next step: its room
	 * lease keeps being renewed until this attempt's heartbeat stops, so a
	 * slow cleanup (or a step ending at its deadline) never lets it lapse
	 * before the next step acquires it.
	 */
	let leaseCarried = false;
	let closeMcp: (() => Promise<void>) | undefined;
	// Cross-chat memory and its VM clone; the clone's token is released when
	// this step ends, however it ends.
	let memoryLoading: Promise<TurnMemory | null> = Promise.resolve(null);
	let memoryCloned: Promise<void> | undefined;
	/** The clone once the workspace started it (settled with it). */
	let memoryCloning: Promise<void> | undefined;
	// Plain git on the VM; its machine token, too, goes when this step ends.
	let machineGit: MachineGitStep | null = null;
	let machineGitPrepared: Promise<void> | undefined;
	/**
	 * The first step's workspace preparation, settled. A turn that ran no
	 * tools ends without it; the step still lets it finish (the chat's next
	 * turn waits for this step, so two preparations never share the VM).
	 */
	let preparation: Promise<void> | undefined;
	let lastCoordinationRenewal = 0;
	/** The database heartbeat's last success; the lease holds 45 s past it. */
	let lastDatabaseRenewal = Date.now();
	let evaluation: EvaluationRun | null = null;
	const heartbeat = setInterval(() => {
		const guardHeartbeat = (stage: string, operation: Promise<void>) =>
			operation.catch((error: unknown) => {
				if (turnSettled) return;
				// One failed database renewal (a dropped connection, a blip shared
				// by every chat at once, Nov 12 00:16 and 00:19) says nothing about
				// the lease, which holds 45 s past the last success. The next tick
				// tries again; only a failure that lasts stops the turn.
				if (
					stage === "database-renewal" &&
					!isPlatformRestart(error) &&
					Date.now() - lastDatabaseRenewal < DATABASE_HEARTBEAT_GRACE_MS
				) {
					console.warn("Turn heartbeat failed once; trying again.", {
						sinceLastRenewalMs: Date.now() - lastDatabaseRenewal,
						...apiTurnFailureClassification(error),
					});
					return;
				}
				heartbeatFailed = true;
				if (error instanceof CoordinationFailure) coordinationFailure ??= error;
				console.warn("Turn heartbeat failed", {
					stage,
					...apiTurnFailureClassification(error),
				});
				abort.abort(
					isPlatformRestart(error)
						? error
						: new Error(
								"Turn heartbeat or coordination service became unavailable.",
							),
				);
			});
		if (
			(coordinated || leaseCarried) &&
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
		if (turnSettled || heartbeatBusy || abort.signal.aborted) return;
		heartbeatBusy = true;
		const databaseHeartbeat = guardHeartbeat(
			"database-renewal",
			renewApiTurn(turn).then(async (alive) => {
				lastDatabaseRenewal = Date.now();
				if (!alive && !turnSettled) {
					abort.abort(
						new Error("Turn ownership or cancellation state changed."),
					);
					// The lease is lost: its runner box loses its VM grant.
					void releaseBoxTools();
				}
				// Send on a queued message: a model call still sampling (no tool
				// started) is dropped like a soft deadline, so the next step
				// reads the message now. A running tool is never interrupted.
				if (
					alive &&
					!toolsStarted &&
					!softStop.signal.aborted &&
					turn.session_id &&
					queuedMessageSentNow(turn.session_id)
				)
					softStop.abort(new Error("A queued message was sent."));
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
	// Reads no lease holder changes (the account's Codex sign-in, the model
	// connection, the eval user's variant) start before the coordination
	// lease is acquired; nothing uses them unless the turn then owns it.
	const subscription = subscriptionTurnSettings(route.connectionRevision);
	// Claude Code on the user's Claude subscription: the CLI runs on the VM.
	const claudeCode =
		!route.connectionId && isClaudeCodeRevision(route.connectionRevision);
	// Prepaid plans (ChatGPT, Claude, Grok) draw from the user's plan, not a
	// paid key: the API token safety budget does not apply to them.
	let prepaidPlan = Boolean(subscription) || claudeCode;
	const checkingCodexAuth =
		subscription && !route.connectionId
			? timed("turn:codexAuth", () => hasManagedCodexAuth(turn.user_id))
			: Promise.resolve(false);
	const loadingConnection =
		!subscription && route.connectionId
			? timed("turn:connection", () =>
					loadModelConnection(turn.user_id, route.connectionId as string),
				)
			: Promise.resolve(null);
	const loadingVariant = turnHarnessVariant(
		turn.id,
		turn.user_id,
		harnessVariantForUser,
	);
	const loadingRecordsRequests = turnRecordsRequests(
		turn.id,
		turn.user_id,
		isDevEvalUser,
	);
	for (const loading of [
		checkingCodexAuth,
		loadingConnection,
		loadingVariant,
		loadingRecordsRequests,
	])
		loading.catch(() => {});
	// Stop reaches this turn directly when it runs in this process: the model
	// stream and its commands stop now, not at the next heartbeat.
	const forgetLiveTurn = registerLiveTurn(turn.id, (reason) =>
		abort.abort(reason),
	);
	try {
		failureStage = "coordination";
		if (
			!turn.lease_id ||
			!(await timed("turn:acquire", () =>
				acquireConversationTurn(
					control,
					abort.signal,
					coordinateConversationTurn,
				),
			))
		)
			throw new Error("The conversation is already running or was stopped.");
		coordinated = true;
		timing?.mark("leaseAcquired");
		failureStage = "connection";
		lastCoordinationRenewal = Date.now();
		// The session row is read once the lease is held (a code restore that
		// held it may have changed the row); it overlaps the lease renewal, and
		// nothing uses it unless the renewal confirms this turn still owns it.
		// The turn already carries the session's items (every write mirrors both).
		const loadingMetadata = timed("turn:metadata", () =>
			agentSessionMetadataForOwner(turn.user_id, turn.session_id),
		);
		loadingMetadata.catch(() => {});
		if (!(await timed("turn:renew", () => renewApiTurn(turn)))) {
			abort.abort();
			abort.signal.throwIfAborted();
		}
		const metadata = await loadingMetadata;
		timing?.mark("leaseRenewed");
		const owner = metadata && { ...metadata, items: turn.items };
		if (!owner) throw new Error("Task no longer exists.");
		sideConversation = isSideChat(owner);
		// While Main's turn runs, a side turn reads the shared checkout but
		// cannot write it, so it can never undo or break Main's work.
		const sideReadOnly =
			sideConversation && owner.parentSessionId
				? sideChatReadOnly(
						(
							await agentSessionMetadataForOwner(
								owner.userId,
								owner.parentSessionId,
							)
						)?.turnStatus,
					)
				: false;
		// A child without a subagent role belongs to the retired lead/child
		// architecture; only the root builder and its subagents run.
		if (owner.parentSessionId && !owner.agentRole)
			throw new Error("This retired child task can no longer run.");
		if (process.env.YTIMESY_HARNESS_EVALUATION_ENABLED === "1")
			evaluation = await evaluationRunForTask(owner.userId, owner.id);
		// A project's secrets load while the turn's variant and route are read.
		const loadingSecrets = owner.projectId
			? timed("turn:secrets", () =>
					turnMemo(`${turn.id}:project-secrets`, () =>
						loadAgentProjectSecrets(
							owner.userId,
							owner.projectId as string,
						).catch((error) => {
							// The turn goes on without them; say so in the logs.
							console.warn("Project secrets could not be loaded.", {
								message: (error as Error).message,
							});
							return {
								envFile: agentSecretsEnvFile([]),
								redact: [],
								names: [],
							};
						}),
					),
				)
			: Promise.resolve(null);
		loadingSecrets.catch(() => {});
		// The project's imported local sessions ("Continue your agent
		// session") go on a root chat's machine, for the agent to grep.
		const loadingHandoffs: Promise<readonly ImportedSessionRow[]> =
			owner.projectId && !owner.parentSessionId && !evaluation
				? turnMemo(`${turn.id}:handoff-history`, () =>
						projectImportedSessions(owner.userId, owner.projectId as string),
					).catch((error) => {
						console.warn("Imported sessions could not be listed.", {
							message: (error as Error).message,
						});
						return [];
					})
				: Promise.resolve([]);
		// A project with Y on (project.y_enabled) makes its chats Y and its
		// pinned Y² chat Y² (src/domain/y-agent.ts, src/domain/y-squared.ts).
		// A failed read keeps the turn as it was.
		const projectY = owner.projectId
			? await projectYMode(owner.userId, owner.projectId).catch(() => null)
			: null;
		const loadedVariant = await loadingVariant;
		const variant: HarnessVariant = projectY?.enabled
			? { ...loadedVariant, y: "on" }
			: loadedVariant;
		const ySquared =
			variant.y === "on" &&
			!owner.parentSessionId &&
			!!projectY?.ySquaredId &&
			owner.id === projectY.ySquaredId;
		if (owner.agentRole && !sideConversation) subagentSession = owner;
		// Builder subagents (harness variant subagents=on): the agent tools
		// and per-level budgets. Children carry the role.
		// Lead mode fusion implies them: the lead delegates to its sidekick.
		const subagentsOn =
			variant.subagents !== "off" ||
			variant.lead === "fusion" ||
			// Y only delegates (src/domain/y-agent.ts).
			variant.y === "on" ||
			!!owner.agentRole;
		if (variant.lead === "fusion" && !owner.parentSessionId)
			fusionLead = { userId: owner.userId, id: owner.id };
		fusionRoleModels = variant.roleModels;
		fusionThinLead = variant.lead === "fusion" && variant.leadTools === "thin";
		yVariant = variant.y === "on";
		const subagentLevel = owner.agentRole
			? (
					await turnMemo(`${turn.id}:subagent-ancestors`, () =>
						subagentAncestors(owner.userId, owner.id),
					)
				).length
			: 0;
		const apiSettings: ApiTurnSettings = subscription
			? {}
			: (route.settings ?? {});
		// This turn's reasoning effort; children on another model inherit it.
		const turnReasoning = subscription?.reasoning ?? apiSettings.reasoning;
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
		} else if (claudeCode) {
			if (!claudeSubscriptionEnabled())
				throw new Error("Claude Code is not available.");
			if (!step)
				throw new Error("Claude Code chats run on the durable executor only.");
			// An earlier step's CLI may still run on the chat's machine.
			const claudeCodeOwner = owner;
			const candidate = claudeRunnerFor({
				env: process.env,
				userId: turn.user_id,
				sessionId: owner.id,
				reader: isReaderRole(owner.agentRole) || sideReadOnly,
				ySquared: Boolean(ySquared),
			});
			// Y² has no machine for the CLI: only a runner box can host it.
			if (ySquared && !candidate) throw new ClaudeRunnerRequired();
			activeClaudeRunner = candidate ? pinnedClaudeRunner(candidate) : null;
			stopClaudeCodeRun = () =>
				Promise.all([
					stopClaudeCodeTurnRun({
						machines: unscopedMachines,
						vm:
							execution?.vm ??
							(claudeCodeOwner.providerRef
								? WorkspaceId(claudeCodeOwner.providerRef)
								: null),
						turnId: turn.id,
						runner: activeClaudeRunner,
					}),
					// The stopped run's box loses its grant with it.
					releaseBoxTools(),
				]).then(() => undefined);
			// A refused or removed token is a route failure: the turn fails over.
			const status = await claudeSubscriptionStatus(turn.user_id);
			if (status.status === "disconnected" || status.status === "refused") {
				failureStage = "model";
				failoverScope = {
					evaluation: Boolean(evaluation),
					child: Boolean(owner.parentSessionId),
					runtime: "api",
					role: analyticsAgentRole(owner),
				};
				throw new ClaudeSubscriptionRefused();
			}
		} else {
			if (!route.connectionId) throw new Error("Model connection was removed.");
			const connection = await loadingConnection;
			if (connection?.revision !== route.connectionRevision)
				throw new Error(
					"The API connection changed after this turn was submitted.",
				);
			if (connection.subscription) prepaidPlan = true;
			nativePatch =
				connection.provider === "openai" &&
				connection.baseUrl.startsWith("https://api.openai.com/");
			if (officialProviderEndpoint(connection))
				webSearch = nativeWebSearchTools(connection.provider);
		}
		timing?.mark("settings");
		toolTime?.setKind(
			claudeCode ? "claude-code" : owner.harness === "codex" ? "codex" : "api",
		);
		failoverScope = {
			evaluation: Boolean(evaluation),
			child: Boolean(owner.parentSessionId),
			runtime: owner.harness === "codex" ? "codex" : "api",
			role: analyticsAgentRole(owner),
		};
		// The root chat is the builder itself; writer subagents build too.
		// Y² reads only the database (y-squared-tools.ts): no checkout to write.
		const writable = writesOwnCheckout(owner) && !sideReadOnly && !ySquared;
		// Cross-chat memory (Agent Memory Repo) for the root builder, never
		// benchmarks. Loaded alongside the rest of the setup; never fails a turn.
		memoryLoading =
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
		// Its subagents read the same project's memory, never write it: no
		// save hook, no ~/memory clone; they get read-only search and read
		// tools over the memory snapshot and its index. Same
		// exclusions as the root chat's.
		const childRole = owner.parentSessionId ? owner.agentRole : null;
		const subagentMemoryLoading =
			childRole && !evaluation
				? timed("turn:memory", () =>
						turnMemo(`${turn.id}:subagent-memory`, () =>
							subagentMemory(
								{
									id: owner.id,
									userId: owner.userId,
									projectId: owner.projectId ?? null,
									role: childRole,
								},
								{ wording: variant.memoryWording },
							),
						),
					).catch(() => null)
				: Promise.resolve(null);
		// Turn-fixed configuration is loaded by the turn's first durable step and
		// reused by later steps in the same isolate (see turn-memo). It may change
		// between turns; within one, keeping it fixed also keeps the tools and the
		// system prompt byte-stable for provider prompt caching. A restarted or
		// evicted isolate (including a resumed step) simply loads it again.
		const projectSecrets = await loadingSecrets;
		const handoffSessions = await loadingHandoffs;
		// Readers keep the values for redaction but get no env file or names.
		const receivesSecrets = sessionReceivesProjectSecrets(owner);
		// Values every tool result is redacted of. The memory clone's token
		// joins once it is on the VM, so tools read this list at call time.
		const redact: string[] = [...(projectSecrets?.redact ?? [])];
		/**
		 * The turn's own tokens this step put on the VM (machine git, ~/memory):
		 * a Claude runner box serving tools itself redacts these (never the
		 * project's secrets or the user's Claude token, which stay here).
		 */
		const vmTokens: string[] = [];
		/** Told to the agent once, on its first tool result, when its machine was replaced. */
		let workspaceNote: string | null = null;
		// Readers' commands run as another user without the network; evaluations never reach GitHub.
		machineGit = receivesSecrets && !evaluation ? machineGitStep(owner) : null;
		let secretsWritten: Promise<void> | undefined;
		let attachmentsWritten: Promise<void> | undefined;
		let handoffWritten: Promise<void> | undefined;
		// Durable steps start at 1; a resumed first step reuses the deduped notice.
		const firstStep = step ? step.index === 1 : !continued;
		// A durable turn's first request need not wait for the workspace: a
		// root builder on a lean surface whose VM is not ready within a short
		// wait sends it with the repository path its chat (or project) last
		// reported; tools still wait for the workspace, and the step ends
		// only once the workspace and the UserPromptSubmit check are done.
		const earlyFirstRequestEligible =
			!!step &&
			firstStep &&
			!step.resumed &&
			writable &&
			!owner.parentSessionId &&
			!owner.agentRole &&
			!evaluation &&
			variant.lead === "off" &&
			attemptLimit(variant.attempts) <= 1 &&
			variant.review !== "on";
		// Why not, for the step's timing line (decided further below when eligible).
		const earlyIneligible: EarlyRequestReason | null = earlyFirstRequestEligible
			? null
			: !firstStep
				? "not-first-step"
				: step?.resumed
					? "resumed"
					: !writable || owner.parentSessionId || owner.agentRole
						? "not-root-builder"
						: evaluation
							? "evaluation"
							: "harness-variant";
		if (earlyIneligible) timing?.early(false, earlyIneligible);
		// Y² has no machine: a path that still asks for one fails instead of
		// copying or waking a VM.
		const prepareWorkspace = ySquared
			? refusedApiTurnWorkspace(Y_SQUARED_NO_WORKSPACE)
			: deferredApiTurnWorkspace(
					turnMachines,
					owner,
					abort.signal,
					workspaceReuse,
					{
						pinNewChatBase: earlyFirstRequestEligible,
						onPhase: (phase) => timing?.mark(phase),
					},
				);
		let codePoint: Promise<void> | undefined;
		/** Set once the checkout (without ~/memory) is ready. */
		let checkoutReady = false;
		// A root builder's repository path lets its next turn (and a new chat in
		// the same project) build its first request before its VM is ready.
		const remembersDirectory =
			writable && !owner.parentSessionId && !evaluation;
		// ~/memory is cloned beside the checkout, never inside it. The memory
		// token is added to the redaction list before it reaches the VM, so
		// only what reads ~/memory (tools) waits for the clone.
		const cloneMemory = (ready: AgentToolWorkspace) =>
			memoryLoading.then((memory) => {
				if (!memory) return;
				const redacted = (token: string) => {
					if (!redact.includes(token)) redact.push(token);
					if (!vmTokens.includes(token)) vmTokens.push(token);
				};
				memoryCloned ??= memory.prepareVm(ready, redacted).then(() => {
					for (const token of memory.vmTokens()) redacted(token);
					timing?.mark("memoryCloned");
				});
				return memoryCloned;
			});
		/**
		 * The checkout, its code point, attachments and secrets, without
		 * waiting for ~/memory: the prompt check, repository instructions and
		 * memory's own path check read only the checkout.
		 */
		const checkout = async () => {
			const preparing = timed("turn:workspace", prepareWorkspace);
			preparing.catch(() => {});
			// The code point, attachments, secrets and ~/memory need only the
			// checked-out repository, so they run beside its baselines.
			const ready = await (prepareWorkspace.checkedOut?.() ?? preparing);
			let secretsReady: Promise<void> | undefined;
			if (projectSecrets && receivesSecrets) {
				const { machines: vmMachines, vm } = ready;
				// The env file stays on the VM's disk across steps; a new VM gets it written.
				secretsWritten ??= turnMemo(
					`${turn.id}:project-secrets-written:${vm}`,
					() =>
						turnSpan("turn:secretsWritten", () =>
							writeAgentProjectSecrets(vmMachines, vm, projectSecrets),
						),
				);
				// Written outside the repository, so it overlaps the attachments and
				// code point below; the workspace is returned only after all three.
				secretsReady = secretsWritten;
				secretsReady.catch(() => {});
			}
			// Outside the repository too; its token joins the redaction list first.
			const git = machineGit;
			machineGitPrepared ??= git
				? turnSpan("turn:machineGit", () =>
						git.prepareVm(ready, (token) => {
							if (!redact.includes(token)) redact.push(token);
							if (!vmTokens.includes(token)) vmTokens.push(token);
						}),
					)
				: undefined;
			attachmentsWritten ??= turnSpan("turn:attachments", () =>
				materializeMessageAttachments(
					ready.machines,
					ready.vm,
					owner.userId,
					owner.id,
					sessionAttachments(items),
				),
			).catch((error) => {
				// A missing file surfaces when the agent opens it; other tools keep working.
				console.warn("Attached files could not be restored.", error);
			});
			// ~/.ytimesy/handoff is outside the repository too.
			if (handoffSessions.length)
				handoffWritten ??= materializeHandoffHistory(
					ready.machines,
					ready.vm,
					owner.userId,
					handoffSessions,
				).catch((error) => {
					// The chat works without them; its handoff is in the context.
					console.warn("Imported sessions could not be restored.", error);
				});
			// ~/memory is outside the repository, so it overlaps the code point.
			memoryCloning ??= cloneMemory(ready);
			memoryCloning.catch(() => {});
			// Attachments go to a directory outside the repository, so they
			// overlap the code point (a capture of the repository) too.
			// A shared writer (lead mode fusion's sidekick) works in its lead's
			// checkout, whose code points are the lead's.
			if (writable && owner.taskPlacement !== "shared") {
				const prompt = [...items]
					.reverse()
					.find((item) => item.kind === "userMessage");
				if (prompt) {
					// It captures the files without moving HEAD or the index
					// (a temporary index and its own ref), so the baselines'
					// pristine check beside it reads the same checkout.
					codePoint ??= turnSpan("turn:codePoint", () =>
						ensureConversationCodePoint(
							owner.userId,
							owner.id,
							prompt.id,
							ready,
						),
					);
					codePoint.catch(() => {});
				}
			}
			execution = await preparing;
			timing?.mark("workspacePrepared");
			if (execution.replacedFrom !== undefined)
				workspaceNote ??= workspaceReplacedNote();
			if (remembersDirectory) {
				const { cwd } = execution;
				void turnMemo(`prepared-checkout-directory:${owner.id}:${cwd}`, () =>
					savePreparedCheckoutDirectory(owner.userId, owner.id, cwd),
				).catch(() => {});
			}
			// The turn still waits for the capture (it records the files as they
			// were before the agent edits), but a capture that fails only means
			// no code rewind point for this message; it never refuses the turn.
			await codePoint?.catch((error) => {
				console.warn("Code recovery point skipped.", {
					...apiTurnFailureClassification(error),
				});
			});
			await attachmentsWritten;
			await handoffWritten;
			await secretsReady;
			await machineGitPrepared;
			checkoutReady = true;
			timing?.mark("checkoutReady");
			return execution;
		};
		/** The whole workspace: the checkout and ~/memory, for tools. */
		const workspace = async () => {
			const ready = await checkout();
			await memoryCloning;
			return ready;
		};
		// A message delivered mid-turn brings its files to a machine already prepared;
		// a machine prepared later restores them from the transcript.
		const materializeDeliveredAttachments = async (
			delivered: readonly UserMessageItem[],
		) => {
			const attachments = delivered.flatMap((item) => item.attachments ?? []);
			if (!attachments.length || !execution) return;
			await materializeMessageAttachments(
				execution.machines,
				execution.vm,
				owner.userId,
				owner.id,
				attachments,
			).catch((error) => {
				console.warn("Attached files could not be restored.", error);
			});
		};
		machines = machinesForAgentSession(turnMachines, owner);
		// Fed by tool calls below: API turns' own, and Claude Code's bridged
		// ones only when nothing of the run lives on the VM.
		if (pausingWhileThinking)
			thinkingPause = thinkingPauseScheduler({
				vm: () => execution?.vm,
				machines: plainMachines,
				otherTurnOnMachine: (vm) =>
					otherRunningTurnOnMachine(owner.userId, turn.id, vm),
			});
		queueMachines = machinesForAgentSession(unscopedMachines, owner);
		publishProgress = async (turnStatus) => {
			if (turnStatus === "running") {
				progress.offer(items);
				await progress.drain();
			}
		};
		// The first step's UserPromptSubmit check always prepares a writable
		// workspace (before the model is called, unless the first request goes
		// out early, below); start it now so the VM work overlaps the remaining
		// setup. It is the same memoized preparation, so a failure still
		// surfaces where the workspace is awaited.
		if (firstStep && writable)
			preparation = workspace().then(
				() => {},
				() => {},
			);
		/** Set when the first request goes out before the workspace is ready. */
		let earlyPromptCheck: Promise<PromptCheck> | undefined;
		// Repository instructions a first request went out without are
		// checked by the next step (see automaticRepositoryContext).
		const deferredInstructionsKey = `${turn.id}:instructions-deferred`;
		const instructionsOwed =
			!!step &&
			step.index > 1 &&
			(!hasRepositoryInstructions(messages) ||
				(await turnMemo(
					deferredInstructionsKey,
					async () => false,
					() => false,
				)));
		if (instructionsOwed) setTurnMemo(deferredInstructionsKey, false);
		// A later durable step starts from items its predecessor just
		// checkpointed (and delivered); republishing them is a wasted write and
		// relay on every step.
		const running =
			step && step.index > 1
				? Promise.resolve()
				: timed(
						"turn:publishRunning",
						() => publishProgress?.("running") ?? Promise.resolve(),
					);
		// Awaited below; this only keeps an early failure from being unhandled.
		running.catch(() => {});
		// A read-only subagent's commands run as the reader Linux user, which
		// cannot write the checkout (reader-workspace-machines.ts), so it gets
		// the command runner its shell surface is built on.
		const reader = isReaderRole(owner.agentRole) || sideReadOnly;
		const subagentMemoryTools = (await subagentMemoryLoading)?.tools;
		const originalTools: ToolSet = {
			...apiAgentTools({
				machines,
				session: owner,
				workspace,
				turnId: turn.id,
				nativePatch,
				freeformPatch,
				toolCallPrefix: step ? `step-${step.index}:` : undefined,
				signal: abort.signal,
				writable,
				readerCommands: reader,
				waitDeadlineAt: step?.waitDeadlineAt,
				repositoryWorkspace: checkout,
			}),
			...subagentMemoryTools,
		};
		// Why the chat's hook configuration was not known without the
		// workspace, for the step's timing line (knownConfig below).
		let hookConfigUnknown: EarlyRequestReason = "hook-config-unknown";
		const hooks = harnessLifecycleHooks({
			// Hooks run in the checkout; the memory token is redacted from
			// their output before the clone puts it on the VM.
			workspace: checkout,
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
			// Read from a baseline commit, a configuration never changes: later
			// turns read it from the chat's journal instead of the VM.
			configCache: (key, load) =>
				turnMemo(`${turn.id}:${key}`, async () => {
					const saved = lifecycleHookConfig.safeParse(
						await readSessionDerivedValue(owner.userId, owner.id, key).catch(
							() => null,
						),
					);
					if (saved.success) return saved.data;
					const loaded = await load();
					void saveSessionDerivedValue(
						owner.userId,
						owner.id,
						key,
						loaded,
					).catch(() => {});
					return loaded;
				}),
			redact,
			// Without the workspace: the pinned baseline of the path the chat
			// last reported, and the configuration journaled for it. A new chat
			// has no baseline yet; when the commit its checkout will hold is
			// known now (pinNewChatBase: its new branch's start, or its template
			// copy's commit), the configuration another chat of the same user's
			// project read from that very commit answers for it, else that
			// commit's file read from GitHub (still the VM's baseline). Hooks
			// come only from the repository at the baseline (.ytimesy/hooks.json;
			// plugin hooks are not run), so the commit names all of it.
			knownConfig: async () => {
				if (!reportedDirectory) return null;
				// Both reads; the pinned base (a new chat's) is already in flight.
				const pinning = prepareWorkspace.pinnedBase?.();
				pinning?.catch(() => {});
				const base = await readVerificationBaseline(
					owner.userId,
					owner.id,
					reportedDirectory,
				);
				if (base) {
					if (!/^[a-f0-9]{40,64}$/.test(base)) return null;
					const saved = await readSessionDerivedValue(
						owner.userId,
						owner.id,
						`lifecycle-hooks:${reportedDirectory}:${base}`,
					);
					if (saved === null) hookConfigUnknown = "hook-config-unjournaled";
					return saved;
				}
				const pinned = await pinning;
				if (!pinned || !owner.projectId) {
					hookConfigUnknown = "hook-config-no-pinned-base";
					return null;
				}
				const journaled = await readProjectDerivedValue(
					owner.userId,
					owner.projectId,
					`lifecycle-hooks:${reportedDirectory}:${pinned}`,
				);
				if (journaled !== null) return journaled;
				// No chat of the project read that commit's configuration yet
				// (its base branch moved): the same file at the same commit,
				// read from GitHub while the VM boots.
				const file = lifecycleConfigFromFile(
					(await prepareWorkspace.pinnedBaseFile?.(
						pinned,
						LIFECYCLE_CONFIG_PATH,
					)) ?? null,
				);
				if (file === null) hookConfigUnknown = "hook-config-unreadable";
				return file;
			},
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
		// A root chat has a person who can answer cards (a project secret);
		// benchmarks and child agents have no one to answer.
		const rootChat = !owner.parentSessionId && !evaluation;
		const repositoryContext = automaticRepositoryContext({
			tools: originalTools,
			workspace: checkout,
			signal: abort.signal,
			// Builders get repository instructions as messages, like AGENTS.md in Codex.
			instructionMessages: {
				turnStart: () =>
					!ySquared &&
					(step
						? step.index === 1
							? !earlyPromptCheck
							: instructionsOwed
						: !continued),
			},
			onEvent: async (event) => {
				items = applyApiProgress(items, turn.id, event);
				progress.offer(items);
			},
		});
		// The builder's tool surface (docs/builder-tool-surface.md): "current"
		// for everyone; a development eval user's harness variant may pick a
		// lean one (docs/parallel-evals.md). Read-only subagents get it too:
		// their commands run as the reader Linux user that cannot write the
		// checkout (reader-workspace-machines.ts).
		const surface = builderToolSurface({
			variant: variant.toolSurface,
			modelId: route.modelId,
			tools: repositoryContext.tools,
			readOnly: reader,
			lean: {
				workspace,
				sessionId: owner.id,
				turnId: turn.id,
				toolCallPrefix: step ? `step-${step.index}:` : undefined,
				signal: abort.signal,
				memo: (key, load) => turnMemo(`${turn.id}:${key}`, load),
				// The agent's ytimesy-browser screenshots and recordings go to its
				// pull request's Evidence section (agent-captures.ts).
				...(rootChat && owner.projectId
					? {
							collectCaptures: async (captureWorkspace, toolCallId) =>
								agentCapturesNote(
									await collectAgentCaptures({
										shell: (command, timeout) =>
											captureWorkspace.machines.exec(
												captureWorkspace.vm,
												command,
												timeout,
											),
										userId: owner.userId,
										projectId: owner.projectId as string,
										sessionId: owner.id,
										itemId: `${turn.id}:${toolCallId}`,
									}),
								),
						}
					: {}),
			},
		});
		const surfaceTools = surface.tools;
		// A lean surface names the repository's absolute path in its system
		// prompt (Claude Code's tools take absolute paths). Later steps reuse
		// the memo, so the prompt stays byte-stable for caching. An early first
		// request names the path the chat (or its project's latest chat) last
		// reported; the workspace corrects it for later steps if it moved.
		// Preparing the workspace here is a workspace failure, not a connection one.
		failureStage = "workspace";
		const leanDirectoryKey = `${turn.id}:lean-working-directory`;
		let reportedDirectory: string | null = null;
		if (earlyFirstRequestEligible && !surface.lean)
			timing?.early(false, "not-lean-surface");
		if (surface.lean && earlyFirstRequestEligible) {
			// A chat with no VM yet (a new chat) is still being given one, which
			// takes over a second: waiting for it only delays the request.
			if (
				owner.providerRef &&
				(await settlesWithin(checkout(), FIRST_REQUEST_WORKSPACE_WAIT_MS))
			)
				timing?.early(false, "workspace-ready");
			else {
				reportedDirectory = await timed("turn:checkoutDirectory", () =>
					readPreparedCheckoutDirectory(
						owner.userId,
						owner.id,
						owner.projectId ?? null,
					),
				).catch(() => null);
				// A project's first chat: where its fresh template copy holds the
				// repository (a wrong guess is corrected below, as for a moved path).
				reportedDirectory ??=
					(await prepareWorkspace.plannedDirectory?.()) ?? null;
				if (!reportedDirectory) timing?.early(false, "no-reported-directory");
			}
		}
		// Whether the chat's known hook configuration has a UserPromptSubmit
		// hook: read-only, so it runs beside the MCP, plugin and memory setup
		// below and is awaited where the first request is decided.
		const promptSubmitKnown =
			firstStep && reportedDirectory ? hooks.promptSubmitConfigured() : null;
		const leanWorkingDirectory =
			surface.lean && !ySquared
				? (reportedDirectory ??
					(await turnMemo(
						leanDirectoryKey,
						async () => (await checkout()).cwd,
					)))
				: undefined;
		if (reportedDirectory) {
			const named = reportedDirectory;
			setTurnMemo(leanDirectoryKey, named);
			checkout().then(
				({ cwd }) => {
					if (cwd === named) return;
					console.warn(
						"The early first request named a moved repository path.",
					);
					setTurnMemo(leanDirectoryKey, cwd);
				},
				() => {},
			);
		}
		failureStage = "connection";
		// The user's remote MCP servers are called from here; credentials never reach the VM.
		// Y² has no use for them: none are loaded, so none can be reported as failed.
		// Connections are live HTTP clients bound to this step's request, so a
		// step that calls a tool connects again; the tool lists are reused. A
		// list with OAuth servers is re-read each step because a token refresh
		// rotates their record.
		const connecting = timed("turn:mcp", async () =>
			// On a box the edge lists and calls them (no credential on the box).
			ports.mcpTools && !ySquared
				? ports.mcpTools(abort.signal)
				: connectMcpTools(
						await Promise.all(
							(ySquared
								? []
								: await turnMemo(
										`${turn.id}:mcp-servers`,
										() =>
											connectableMcpServers(
												owner.userId,
												owner.projectId ?? null,
											),
										(servers) =>
											servers.every((server) => server.auth !== "oauth"),
									)
							)
								// OAuth servers join once the user has signed in.
								.filter(
									(server) => server.auth !== "oauth" || server.sealedOAuth,
								)
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
													appUrl:
														process.env.APP_URL ?? "http://localhost:3000",
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
				enabledPluginSkillIndex(owner.userId, owner.projectId ?? null),
			),
		);
		// Independent loads run together; connected MCP clients are always
		// registered for closing, and failures surface in their original order.
		const [published, connected, loaded] = await Promise.allSettled([
			running,
			connecting,
			loadingPlugins,
		]);
		timing?.mark("toolsLoaded");
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
		// The builder and subagents above the deepest level may delegate; a
		// checker reviews the deliverable itself, on the smallest surface.
		const delegates =
			subagentsOn &&
			!!surface.lean &&
			!isSideChat(owner) &&
			(owner.agentRole
				? owner.agentRole !== "checker" &&
					// A sidekick does the work itself (lead mode fusion).
					!isActiveSidekick(owner) &&
					// So does a checker pair's worker (checkerMode=pair).
					owner.agentBudget?.checkerPair !== "worker" &&
					subagentLevel < MAX_SUBAGENT_LEVEL
				: !owner.parentSessionId);
		// Harness variant y=on (src/domain/y-agent.ts): the root chat is Y. It
		// delegates every change to builders and keeps no file or shell tools.
		const yAgent =
			variant.y === "on" &&
			!ySquared &&
			delegates &&
			!owner.parentSessionId &&
			!owner.agentRole &&
			!claudeCode;
		// checkerMode=pair: the judge's only delegation is its worker (src/domain/checker-pair.ts).
		const pairJudge =
			!!surface.lean &&
			owner.agentRole === "checker" &&
			owner.agentBudget?.checkerPair === "judge" &&
			subagentLevel < MAX_SUBAGENT_LEVEL;
		const subagentContext: SubagentToolContext = {
			// On a box the tools' database and helper-VM work goes to the edge.
			...(ports.subagentToolDeps ? { deps: ports.subagentToolDeps } : {}),
			machines: unscopedMachines,
			parent: owner as AgentSessionRecord,
			workspace,
			signal: abort.signal,
			waitDeadlineAt: step?.waitDeadlineAt,
			roleModels: variant.roleModels,
			lead: variant.lead,
			y: variant.y === "on",
			parentReasoning: turnReasoning,
			rigor: variant.rigor === "on",
			checkerMode: variant.checkerMode,
			// Lead mode fusion: one writer at a time in the shared checkout.
			onSidekickRound: leadWrites.start,
			leadWritesSettled: leadWrites.settled,
			leadBackgroundCommands: () => pendingAgentCommandIds(items),
		};
		const delegation: ToolSet = delegates
			? withRedactedResults(subagentTools(subagentContext), redact)
			: pairJudge
				? withRedactedResults(checkerWorkerTools(subagentContext), redact)
				: {};
		// Lead mode fusion (src/server/services/fusion-lead.ts): the harness
		// starts the request's exploration and Main waits for it; during build
		// rounds Main is free but its writes refuse.
		// leadTools=thin: the lead only plans, briefs and reviews (thin-lead-tools.ts).
		const thinLead = !!fusionLead && delegates && variant.leadTools === "thin";
		const leadGate =
			fusionLead && delegates
				? (waitUntil: number) =>
						fusionLeadGate({
							context: subagentContext,
							items,
							explore: fusionPairFor(owner.listedModelId, variant.roleModels)
								.sidekickExplores,
							waitUntil,
							thin: thinLead,
						} satisfies FusionLeadGateInput).then((ready) => {
							if (ready === "ready") leadWrites.clear();
							else if (ready === "busy") leadWrites.start();
							return ready;
						})
				: null;
		// checkerMode=pair: the judge waits for its workers' reports (checker-pair-gate.ts).
		const judgeGate = pairJudge
			? (waitUntil: number) =>
					checkerPairGate({
						judge: owner as AgentSessionRecord,
						signal: abort.signal,
						waitUntil,
					})
			: null;
		// Code mode is a development harness variant on a lean surface only
		// (docs/parallel-evals.md). primary: run_code is the main tool; a large
		// MCP setup's search and call tools are callable only from inside it.
		// A Claude Code turn on a runner box (src/domain/claude-runner.ts) gets
		// code mode whatever the variant says: the chat's tools are a network hop
		// away there, and run_code batches them.
		const claudeRunner = activeClaudeRunner;
		const codeMode =
			(surface.lean || claudeCode) &&
			(variant.codeMode !== "off" || claudeCode) &&
			!thinLead &&
			!yAgent &&
			!ySquared
				? variant.codeMode !== "off"
					? variant.codeMode
					: "on"
				: null;
		// Harness variant fetch (on in the product): web_fetch for every agent,
		// as the benchmark bridge's fetch=on, fetched from here (never the VM);
		// private, loopback, link-local and metadata hosts are refused.
		const webFetch: ToolSet =
			variant.fetch === "on" ? webFetchTool({ checkHost: nodePublicHost }) : {};
		const ownTools = turnTools({
			surfaceTools,
			mcp,
			plugins,
			pluginSkillBody: (installId, skill) =>
				pluginSkillBody(owner.userId, installId, skill),
			webSearch,
			webFetch,
			hooks,
			rootChat,
			projectSecrets,
			redact,
			// Display only: a person in a root chat sees the canvas.
			canvas: rootChat
				? canvasTools({
						items: () => items,
						workspace,
						savedRevision: (title) =>
							savedCanvasRevision(turn.session_id, title),
					})
				: {},
			environmentSetup:
				rootChat && owner.projectId
					? environmentSetupTools({
							userId: owner.userId,
							projectId: owner.projectId,
							sessionId: owner.id,
						})
					: {},
			saveSecret:
				rootChat && owner.projectId
					? saveProjectSecretTools({
							runInWorkspace: async (command) => {
								const ready = await workspace();
								return ready.machines.exec(
									ready.vm,
									`${SOURCE_AGENT_SECRETS}\n${command}`,
									30_000,
								);
							},
							save: async ({ scope, ...secret }) => {
								if (scope === "account")
									await saveAccountWideSecret({
										userId: owner.userId,
										...secret,
									});
								else
									await saveVisibleProjectSecret({
										userId: owner.userId,
										projectId: owner.projectId as string,
										...secret,
									});
							},
						})
					: {},
			describeSecret:
				rootChat && owner.projectId && receivesSecrets
					? describeSecretTools({
							values: () => redact,
							save: ({ name, description }) =>
								setSecretDescription({
									userId: owner.userId,
									projectId: owner.projectId as string,
									name,
									description,
								}),
						})
					: {},
			pushApproval:
				rootChat && owner.projectId
					? pushApprovalTools({
							userId: owner.userId,
							projectId: owner.projectId,
							sessionId: owner.id,
							requests: ports.gitPushRequests,
							countCommits: async (oldId, newId) => {
								const ready = await workspace();
								const counted = await ready.machines.exec(
									ready.vm,
									`cd ${posixShellQuoted(ready.cwd)} && ${countCommitsCommand(oldId, newId)}`,
									15_000,
								);
								const count = Number(counted.stdout.trim());
								return counted.exitCode === 0 && Number.isInteger(count)
									? count
									: null;
							},
						})
					: {},
		});
		// Harness variant plan (on in the product): the root builder's
		// update_plan, as the benchmark bridge's plan=on gives it; subagents
		// get none. Each accepted update replaces the turn's checklist item.
		// Claude gets it too: the pinned Claude Code SDK offers no plan tool
		// of its own (no TodoWrite), so this one feeds the chat's checklist.
		const planning: ToolSet =
			!yAgent &&
			!ySquared &&
			variant.plan === "on" &&
			((!owner.parentSessionId && !owner.agentRole) || isSideChat(owner))
				? planTool({
						now: Date.now,
						onUpdate: (update) => {
							items = applyPlanUpdate(items, turn.id, update);
							progress.offer(items);
						},
					})
				: {};
		// Goal mode: the model starts it for long work that must be finished
		// and proven; the harness then sends it back (the completion boundary
		// below) until it marks the goal complete or blocked. The goal lives in
		// the turn's own notice item, so it survives durable steps and restarts.
		const goalMode: ToolSet =
			rootChat && !owner.agentRole && !isSideChat(owner)
				? goalTool({
						state: {
							get goal() {
								return goalOfTurn(items, turn.id)?.state ?? null;
							},
							// The notice (onStart, onUpdate) holds the goal.
							set goal(_goal) {},
						},
						now: Date.now,
						canStart: true,
						onStart: (goal) => {
							// No continuation yet: the first run's tool calls are not counted.
							items = withGoalNotice(items, goalNoticeItem(turn.id, goal, -1));
							progress.offer(items);
						},
						onUpdate: (goal) => {
							const mark = goalOfTurn(items, turn.id)?.toolMark ?? -1;
							items = withGoalNotice(
								items,
								goalNoticeItem(turn.id, goal, mark),
							);
							progress.offer(items);
						},
					})
				: {};
		// The thin lead only inspects, so a round needs no write guard.
		const baseTools: ToolSet = ySquared
			? {
					// Y² asks the person; it has no secret or delegation tools.
					...(ownTools[ASK_USER_TOOL]
						? { [ASK_USER_TOOL]: ownTools[ASK_USER_TOOL] }
						: {}),
					...ySquaredTools({
						userId: owner.userId,
						projectId: owner.projectId as string,
						selfId: owner.id,
						// Only handed to the send/stop paths of other chats: Y²
						// itself never prepares a VM (refusedApiTurnWorkspace).
						machines: unscopedMachines,
						modelId: owner.listedModelId,
						harnessId: owner.harness,
						turnId: turn.id,
						// To see which canvas revisions Y² already shows (show_canvas).
						items: () => items,
					}),
				}
			: yAgent
				? yTools({ ...ownTools, ...delegation })
				: thinLead
					? { ...thinLeadTools({ ...ownTools, ...delegation }), ...planning }
					: {
							...(leadGate
								? withSidekickWriteGuard(ownTools, leadWrites)
								: ownTools),
							...delegation,
							...planning,
							...goalMode,
						};
		// Deferred (deferred-tools.ts): in code mode primary the MCP search and
		// call tools (run_code only). agent, agent_send and
		// request_project_secret are ordinary tools. Additions append, so
		// earlier requests' tool lists stay a cached prefix.
		const deferredNames = [
			...(codeMode === "primary" ? CODE_MODE_DEFERRED_TOOLS : []),
		];
		// Harness variant outputCap: each result the model reads keeps its
		// head and tail within the cap (tool-output-cap.ts).
		const allTools = withWorkspaceNote(
			withOutputCap(
				withCodeMode(
					baseTools,
					codeMode
						? {
								signal: abort.signal,
								sessionId: owner.id,
								turnId: turn.id,
								toolCallPrefix: step ? `step-${step.index}:` : undefined,
								redact,
								mode: codeMode,
								deferred:
									codeMode === "primary"
										? CODE_MODE_DEFERRED_TOOLS.filter(
												(name) => name in baseTools,
											)
										: [],
								// As the bridge: web_fetch and update_plan (whose description
								// says it may be sent inside run_code) are callable too.
								callable: [...Object.keys(webFetch), ...Object.keys(planning)],
							}
						: null,
				),
				outputCapCharacters(variant.outputCap),
			),
			() => {
				const note = workspaceNote;
				workspaceNote = null;
				return note;
			},
		);
		const orderedTools = surface.lean
			? inLeanToolOrder(allTools, {
					surface: Object.keys(surfaceTools),
					webSearch: Object.keys(webSearch),
					runCodeFirst: codeMode === "primary",
				})
			: allTools;
		const deferral = deferredNames.length
			? deferredToolSurface({
					tools: orderedTools,
					deferred: deferredNames,
					loaded: loadedDeferredTools(items, messages, deferredNames),
				})
			: null;
		const tools = deferral?.tools ?? orderedTools;
		if (mcp.unavailable.length) {
			const notice = `${MCP_UNAVAILABLE_PREFIX} ${mcp.unavailable.join(", ")}. Their tools are not offered; continue without them.`;
			if (!messages.some((message) => message.content === notice))
				messages = [...messages, { role: "user", content: notice }];
		}
		// An earlier turn's "unavailable" notice stays in the history; once the
		// server connects again (the user signed in), say so, or the model
		// trusts the old notice and never looks for the tools.
		const reconnected = [
			...new Set(mcp.catalog.map((entry) => entry.server)),
		].filter((server) =>
			messages.some(
				(message) =>
					typeof message.content === "string" &&
					message.content.startsWith(MCP_UNAVAILABLE_PREFIX) &&
					message.content.includes(server),
			),
		);
		if (reconnected.length) {
			const notice = `MCP servers connected this turn: ${reconnected.join(", ")}. The earlier notice that they were unavailable no longer applies; their tools are offered now.`;
			if (!messages.some((message) => message.content === notice))
				messages = [...messages, { role: "user", content: notice }];
		}
		// A request that @mentions helpers: the lead reads which ones are meant.
		if (firstStep)
			messages = await withMentionNote({
				userId: turn.user_id,
				session: owner,
				items,
				messages,
			}).catch(() => messages);
		// Memory rides on the current request as extra parts, so earlier
		// messages and the system prompt stay byte-stable for prompt caching.
		const memory = await memoryLoading;
		if (memory && firstStep) {
			// Recalled paths the checkout no longer has are marked missing. A
			// first request going out before its workspace (the same condition
			// as below) does not wait for the VM for that: they go unmarked.
			const memoryCheckout = async () => {
				if (
					!checkoutReady &&
					promptSubmitKnown &&
					(await promptSubmitKnown) === false
				)
					throw new Error("The checkout is not ready yet.");
				return checkout();
			};
			const attached = await timed("turn:memoryAttach", () =>
				memory.attach(messages, items, memoryCheckout),
			);
			timing?.mark("memoryAttached");
			messages = attached.messages;
			// The chat shows what was recalled; the model sees only the parts above.
			if (attached.recall) {
				items = withMemoryRecall(items, attached.recall);
				progress.offer(items);
			}
		}
		const readOnlyMemory = await subagentMemoryLoading;
		if (readOnlyMemory && firstStep) {
			const attached = await timed("turn:memoryAttach", () =>
				readOnlyMemory.attach(messages, items),
			);
			messages = attached.messages;
			if (attached.recall) {
				items = withMemoryRecall(items, attached.recall);
				progress.offer(items);
			}
		}
		let metricIndex = 0;
		failureStage = "model";
		if (step && (step.limitReached || step.index > modelStepLimit()))
			throw new IncompleteAgentTurn("tool-calls");
		// Once per turn, before its first model request; a resumed first step reuses the journal.
		// A UserPromptSubmit hook can be a policy gate (refuse or redact a
		// prompt), so a first request goes out before this check only when the
		// chat's journaled configuration shows no such hook; unknown (a new
		// chat, a first turn since the journal) waits as before. Its tools still
		// wait for the check, and a late failure ends the turn.
		const promptSubmit = promptSubmitKnown ? await promptSubmitKnown : null;
		if (promptSubmitKnown)
			timing?.early(
				promptSubmit === false,
				promptSubmit === false
					? "early"
					: promptSubmit
						? "prompt-hook-configured"
						: hookConfigUnknown,
			);
		if (firstStep && promptSubmitKnown && promptSubmit === false) {
			earlyPromptCheck = timed("turn:promptHook", () =>
				hooks.userPromptSubmit(
					currentTask?.kind === "userMessage" ? currentTask.text : "",
				),
			);
			earlyPromptCheck.then(
				() => timing?.mark("hookCheck"),
				() => {},
			);
			void turnMemo(deferredInstructionsKey, async () => true);
		}
		if (firstStep && !earlyPromptCheck) {
			const submitted = await timed("turn:promptHook", () =>
				hooks.userPromptSubmit(
					currentTask?.kind === "userMessage" ? currentTask.text : "",
				),
			);
			timing?.mark("hookCheck");
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
		const runModel = subscription
			? (input: Parameters<typeof runCodexSubscriptionAgent>[0]) =>
					(step ? runCodexSubscriptionAgentStep : runCodexSubscriptionAgent)({
						...input,
						...(ports.modelAccess ? { modelAccess: ports.modelAccess } : {}),
					})
			: (input: Parameters<typeof runCodexSubscriptionAgent>[0]) =>
					(step ? runApiAgentStep : runApiAgent)({
						...input,
						connectionId: route.connectionId as string,
						...(ports.modelAccess ? { modelAccess: ports.modelAccess } : {}),
					});
		const runAgent = (input: ModelAgentInput) =>
			(
				runModel(input) as Promise<Awaited<ReturnType<typeof runModel>>>
			).finally(() => requestRecorder?.flush());
		// Development evals record each request's system prompt and tool list.
		const requestRecorder = (await loadingRecordsRequests)
			? modelRequestRecorder({
					sessionId: owner.id,
					turnId: turn.id,
					step: step?.index ?? 0,
				})
			: null;
		const previousContext = recordedContextUsage(items)?.context;
		// A checker's forced final step (guardSubagentStep): tools off for it.
		let checkerFinal = false;
		const agentInput: ModelAgentInput = {
			previousContext:
				previousContext?.modelContextWindow && previousContext.last.totalTokens
					? {
							tokens: previousContext.last.totalTokens,
							modelContextWindow: previousContext.modelContextWindow,
						}
					: undefined,
			cacheScopeId: promptCacheScopeId(variant.promptCacheScope, owner.id),
			instructionVariant: variant.instructions,
			userId: turn.user_id,
			connectionId: route.connectionId ?? undefined,
			connectionRevision: route.connectionRevision,
			// A fusion lead's own calls at most at leadEffort; its writer inherits turnReasoning.
			reasoning: fusionLead
				? leadReasoningEffort(turnReasoning, variant.leadEffort)
				: turnReasoning,
			speed: apiSettings.speed,
			alternateContext:
				(subscription?.alternateContext ?? apiSettings.alternateContext) ===
				true,
			...(deferral ? { toolOrder: deferral.order } : {}),
			...(owner.agentRole === "checker"
				? { toolsOff: () => checkerFinal }
				: {}),
			...(rootChat
				? {
						endTurnTools: [
							...SECRET_REQUEST_END_TURN_TOOLS,
							...ASK_USER_END_TURN_TOOLS,
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
			...(requestRecorder ? { onModelRequest: requestRecorder.record } : {}),
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
			compactNow: endsWithCompactCommand(messages),
			// Lead mode fusion's sidekick: each compaction may switch its model;
			// a pending switch compacts first (src/server/services/sidekick-model-switch.ts).
			...(sidekickState(owner)
				? {
						compactFirst:
							sidekickSwitchDue(
								sidekickState(owner) as NonNullable<
									ReturnType<typeof sidekickState>
								>,
								turn.id,
							) &&
							sidekickSwitchAllowed(
								sidekickState(owner) as NonNullable<
									ReturnType<typeof sidekickState>
								>,
								turn.id,
							),
						switchAtCompaction: sidekickSwitchAtCompaction({
							userId: owner.userId,
							sessionId: owner.id,
							turnId: turn.id,
							roleModels: variant.roleModels,
							items: () => items,
							signal: abort.signal,
						}),
					}
				: {}),
			archiveHistory: async (history) => {
				const reference = await archiveModelContext(
					owner.userId,
					owner.id,
					history,
				);
				// A lean surface has no archive tools: it searches a file instead.
				// Y² has no VM to hold the history file.
				const file = ySquared
					? undefined
					: await surface.lean?.saveHistory(reference, history);
				return file ? { file } : reference;
			},
			instructions: turnInstructions(
				{
					session: owner,
					tools,
					plugins,
					projectKnowledge: null,
					secretNames: receivesSecrets ? projectSecrets?.names : undefined,
					leanShape: surface.lean?.shape,
					leanReadOnly: surface.lean?.readOnly,
					leanWorkingDirectory,
					deferredTools: deferral?.deferred,
					// As the bridge: only when run_code was built.
					codeMode: codeMode && CODE_MODE_TOOL in tools ? codeMode : undefined,
					prEvidence: variant.prEvidence === "on" && writable,
					lead: variant.lead,
					leadTools: thinLead ? "thin" : "full",
					rigor: variant.rigor === "on",
					forceDelegation: variant.subagents === "force",
					y: yAgent,
					ySquared,
					fusionPair:
						variant.lead === "fusion" && !owner.parentSessionId
							? fusionPairFor(owner.listedModelId, variant.roleModels)
							: undefined,
				},
				memory,
				handoffSessions.length > 0,
			),
			tools: earlyPromptCheck
				? withPromptCheckGate(tools, earlyPromptCheck)
				: tools,
			signal: claudeCode
				? abort.signal
				: AbortSignal.any([abort.signal, softStop.signal]),
			onToolStart: (call) => {
				toolsStarted = true;
				if (call && !call.providerExecuted) {
					toolTime?.start(call.toolCallId, call.toolName);
					if (!claudeCode) thinkingPause?.toolStarted(call.toolCallId);
				}
			},
			onToolEnd: (call) => {
				toolTime?.end(call.toolCallId);
				if (!claudeCode) thinkingPause?.toolEnded(call.toolCallId);
			},
			isUserRequest: (message) => isUserRequestMessage(items, message),
			// Y² has no checkout to describe in a compaction.
			compactionSnapshot: ySquared
				? undefined
				: compactionStateSnapshot({
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
				if (!ySquared)
					history = await repositoryContext.restoreInstructions(history);
				await hooks.postCompact(history);
				return hooks.drain(history);
			},
			afterTools: async (history) =>
				hooks.drain(
					ySquared ? history : await repositoryContext.afterTools(history),
				),
			prepareMessages: async (history) => {
				// Each model call starts with no tool run yet: Send may cut it.
				toolsStarted = false;
				// The local worker's loop calls the model several times in one
				// run; durable steps wait before their one call instead (below).
				if (!step && leadGate) await leadGate(Number.POSITIVE_INFINITY);
				if (!step && judgeGate) await judgeGate(Number.POSITIVE_INFINITY);
				if (owner.agentRole && !isSideChat(owner)) {
					// Counted and checked before every model step: a wrap-up
					// notice at 90%, the turn stops at 100% (reported as such).
					failureStage = "budget";
					history = await guardSubagentStep({
						session: owner,
						items,
						messages: history,
						onFinalStep: () => {
							checkerFinal = true;
						},
					});
					failureStage = "model";
				}
				history = withCompactInstruction(history);
				// Y² reads attachments by name (view_image), never by a path.
				if (ySquared) history = ySquaredModelMessages(history);
				// Y² has no checkout to read evidence from and runs no
				// command, so none of the workspace reads below apply to it.
				if (!ySquared) history = await repositoryContext.prepare(history);
				history = hooks.drain(history);
				if (!ySquared)
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
				// Background commands that exited since the last step: their cards and notices.
				const background = ySquared
					? null
					: await withBackgroundCommandNotices({
							workspace,
							sessionId: owner.id,
							items,
							messages: history,
						}).catch((error: unknown) => {
							console.warn("Background commands were not observed.", error);
							return null;
						});
				if (background?.changed) {
					items = background.items;
					history = messages = background.messages;
					await saveCheckpoint();
					await publishProgress?.("running");
					noteUserHub(owner.userId, [hubTopic.commands(owner.id)]);
				}
				// Push cards the user answered meanwhile: the chat's notice, and the agent reads it.
				const pushResults = await withPushResultNotices({
					userId: owner.userId,
					sessionId: owner.id,
					items,
					messages: history,
				}).catch(() => null);
				if (pushResults) {
					items = pushResults.items;
					history = messages = pushResults.messages;
					await saveCheckpoint();
					await publishProgress?.("running");
				}
				let setupCatchUpReady = false;
				history = await injectServerPeerMessages(
					owner.id,
					history,
					async (injected, delivered) => {
						messages = injected;
						if (delivered.length) {
							items = [
								...items,
								...delivered.map((item) => ({
									...item,
									timing: { startedAt: Date.now() },
								})),
							];
							await materializeDeliveredAttachments(delivered);
						}
						await saveCheckpoint();
					},
					(messageId) => items.some((item) => item.id === messageId),
					() => {
						setupCatchUpReady = true;
					},
				);
				// The project's setup finished after this chat's machine booted
				// without its template: its install runs here (no command of the
				// agent's is running between steps), then one note.
				// Y² has no machine to install into.
				if (
					setupCatchUpReady &&
					!ySquared &&
					owner.projectId &&
					!owner.parentSessionId
				) {
					const caughtUp = await withSetupCatchUp({
						sessionId: owner.id,
						userId: owner.userId,
						projectId: owner.projectId,
						messages: history,
						workspace,
						waitUntil: step?.waitDeadlineAt ?? Date.now() + 10 * 60_000,
					});
					if (caughtUp.changed) {
						history = messages = caughtUp.messages;
						items = [
							...items,
							{
								kind: "notice",
								id: SessionItemId(`${turn.id}:setup-catch-up`),
								message: SETUP_CAUGHT_UP_NOTICE,
							},
						];
						await saveCheckpoint();
						await publishProgress?.("running");
					}
				}
				return history;
			},
			beforeStep: async (history) => {
				timing?.mark("promptBuilt");
				failureStage = "budget";
				assertApiContextFits(history);
				abort.signal.throwIfAborted();
				if (evaluation)
					await reserveEvaluationRequest(
						evaluation,
						turn.model_id,
						turn.connection_revision,
					);
				if (!prepaidPlan)
					await reserveApiTokens(
						owner.userId,
						owner.id,
						Math.ceil(Buffer.byteLength(JSON.stringify(history), "utf8") / 3) +
							24_000,
					);
				failureStage = "model";
				timing?.mark("modelRequestSent");
			},
			beforeCompaction: async (older) => {
				failureStage = "budget";
				if (evaluation)
					await reserveEvaluationRequest(
						evaluation,
						turn.model_id,
						turn.connection_revision,
					);
				if (!prepaidPlan)
					await reserveApiTokens(
						owner.userId,
						owner.id,
						Math.ceil(Buffer.byteLength(JSON.stringify(older), "utf8") / 3) +
							4_000,
					);
				failureStage = "model";
			},
			onEvent: async (event) => {
				if (
					event.type === "text-delta" ||
					event.type === "reasoning-delta" ||
					event.type === "tool-call"
				)
					timing?.mark("firstToken");
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
				if (event.type === "finish") {
					progress.offer(items);
					await progress.drain();
				} else progress.stream(items, progress.window());
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
		// The attempt loop (harness variant attempts=3, durable steps only):
		// it checkpoints before the first model step, and a step may instead
		// wait for its checker, start the next attempt with a reset history,
		// or end the loop without a model call.
		// The review loop (review=on) uses the same hooks: a check at the
		// completion boundary, its findings back into the same run.
		const attemptsMax = attemptLimit(variant.attempts);
		const loopEligible =
			!!step && writable && !owner.parentSessionId && !owner.agentRole;
		const loopBilling = modelBilling({
			harness: subscription ? "codex" : "api",
			modelId: route.modelId,
		});
		const attemptLoop =
			step && loopEligible && attemptsMax > 1
				? createAttemptLoop({
						sessionId: owner.id,
						turnId: turn.id,
						max: attemptsMax,
						workspace,
						signal: abort.signal,
						billing: loopBilling,
						taskText: () => latestUserRequestText(items),
						isRequest: (message) => isUserRequestMessage(items, message),
						deps: attemptLoopDeps({
							machines: unscopedMachines,
							parent: owner as AgentSessionRecord,
							turnId: turn.id,
							workspace,
							signal: abort.signal,
							waitDeadlineAt: step.waitDeadlineAt,
							items: () => items,
							roleModels: variant.roleModels,
							parentReasoning: turnReasoning,
						}),
						rigor: variant.rigor === "on",
					})
				: step && loopEligible && variant.review === "on"
					? createReviewLoop({
							sessionId: owner.id,
							turnId: turn.id,
							workspace,
							signal: abort.signal,
							billing: loopBilling,
							taskText: () => latestUserRequestText(items),
							deps: reviewLoopDeps({
								machines: unscopedMachines,
								parent: owner as AgentSessionRecord,
								turnId: turn.id,
								workspace,
								signal: abort.signal,
								waitDeadlineAt: step.waitDeadlineAt,
								items: () => items,
								roleModels: variant.roleModels,
								parentReasoning: turnReasoning,
							}),
							rigor: variant.rigor === "on",
							pair: variant.checkerMode === "pair",
							// Lead mode fusion: a turn that ends while the writer's
							// round runs hands the check to the turn its report wakes.
							...(leadGate ? { handedOff: leadWrites.busy } : {}),
						})
					: null;
		const attemptWaitUntil = () =>
			Math.min(
				step?.waitDeadlineAt ?? Number.POSITIVE_INFINITY,
				Date.now() + 10 * 60_000,
			);
		let result: Awaited<ReturnType<typeof runAgent>>;
		// Lead mode fusion: no model call while the request's exploration runs;
		// one still running at the step's deadline continues the wait in the
		// next step. Its report is in the mailbox once it is ready.
		if (step && leadGate) {
			const gate = await timed("turn:fusionLead", () =>
				leadGate(attemptWaitUntil()),
			);
			if (gate === "wait") {
				await saveCheckpoint();
				coordinated = false;
				leaseCarried = true;
				return "continue";
			}
		}
		// checkerMode=pair: no judge model call while a worker still works.
		if (step && judgeGate) {
			const gate = await timed("turn:checkerPair", () =>
				judgeGate(attemptWaitUntil()),
			);
			if (gate === "wait") {
				await saveCheckpoint();
				coordinated = false;
				leaseCarried = true;
				return "continue";
			}
		}
		const loopStep = attemptLoop
			? await timed("turn:attemptLoop", () =>
					attemptLoop.beforeModel({
						messages,
						items,
						waitUntil: attemptWaitUntil(),
					}),
				)
			: null;
		if (loopStep?.kind === "wait") {
			if (loopStep.items) items = loopStep.items;
			await saveCheckpoint();
			coordinated = false;
			leaseCarried = true;
			return "continue";
		}
		if (loopStep?.kind === "finished") {
			items = loopStep.items;
			messages = loopStep.messages;
			result = { messages, outcome: "completed" };
		} else {
			if (loopStep?.kind === "run") {
				if (loopStep.items) items = loopStep.items;
				if (loopStep.messages) messages = loopStep.messages;
				if (loopStep.items || loopStep.messages) await saveCheckpoint();
			}
			if (claudeCode) {
				// Send on a queued message while the run works: its hooks take it
				// after the next tool call (a run is one model loop, so the step
				// prelude above never sees it). It joins the history before the
				// run's answer, so a later run does not send it again.
				const sentDuringRun: ModelMessage[] = [];
				const takeSentMessages = async () => {
					const before = messages;
					let taken: ModelMessage[] = [];
					await injectServerPeerMessages(
						owner.id,
						before,
						async (injected, delivered) => {
							taken = injected.slice(before.length);
							sentDuringRun.push(...taken);
							messages = injected;
							if (delivered.length) {
								items = [
									...items,
									...delivered.map((item) => ({
										...item,
										timing: { startedAt: Date.now() },
									})),
								];
								await materializeDeliveredAttachments(delivered);
							}
							await saveCheckpoint();
							await publishProgress?.("running");
						},
						(messageId) => items.some((item) => item.id === messageId),
						undefined,
						true,
					);
					return claudeCodeSentMessagesText(taken);
				};
				// The lean workspace tools run on the box itself, with a per-run
				// VM grant, when the flag is on and nothing needs this object
				// around them: no repository tool hooks, and runtime secrets only
				// when the VM redacts them itself (both checked per grant).
				const offerBoxTools = Boolean(
					claudeRunner &&
						!ySquared &&
						surface.lean &&
						!reader &&
						claudeBoxToolsEnabled(process.env) &&
						// With runtime secrets only when the owner allows it:
						// the box's VM token could read them (docs/claude-code-placement.md).
						(!projectSecrets?.redact.length ||
							process.env.YTIMESY_CLAUDE_BOX_TOOLS_SECRETS === "1"),
				);
				// The VM pauses while Claude thinks only when every tool call of
				// the run reaches it through this object: `claude` on a runner box,
				// without box tools. On the chat's VM, `claude` itself (and its
				// model stream) runs there; box tools exec on it unseen here.
				const bridgedPause =
					claudeRunner && !offerBoxTools && !ySquared
						? thinkingPause
						: undefined;
				const claudeToolTime =
					toolTime || bridgedPause
						? {
								start(id: string, tool: string) {
									toolTime?.start(id, tool);
									bridgedPause?.toolStarted(id);
								},
								end(id: string) {
									toolTime?.end(id);
									bridgedPause?.toolEnded(id);
								},
							}
						: undefined;
				const claudeResult = await timed("turn:claudeCode", () =>
					runClaudeCodeTurnStep({
						// Y² has no machine: the CLI runs on the runner box alone,
						// with Y²'s own prompt and only its tools.
						...(ySquared
							? {
									ySquared: { instructions: ySquaredInstructions() },
								}
							: {
									workspace: checkout,
									machines: unscopedMachines,
								}),
						userId: owner.userId,
						sessionId: owner.id,
						turnId: turn.id,
						modelId: route.modelId,
						// The effort chosen in the picker (Claude Code's `effort`).
						effort: apiReasoningEffort(turnReasoning) ?? undefined,
						agentRole: owner.agentRole,
						// Claude starts once the checkout is ready; ~/memory keeps
						// cloning beside it (22-72 s per turn in production), and the
						// tools that read it wait for it through `workspace`.
						messages: ySquared ? ySquaredModelMessages(messages) : messages,
						// One workspace tool lifecycle on either host: commands must be
						// registered for completion notices, Stop and restart recovery.
						tools: claudeCodeBridgeToolSet(
							tools,
							[...Object.keys(webSearch), ...Object.keys(webFetch)],
							true,
						),
						...(claudeRunner
							? {
									runner: {
										box: claudeRunner,
										workspaceTools: ySquared ? [] : Object.keys(surfaceTools),
										...(offerBoxTools && surface.lean
											? {
													boxTools: {
														tools: leanSurfaceToolNames(
															surface.lean.shape,
															surfaceTools,
														),
														shape: surface.lean.shape,
														redact: () => [...vmTokens],
														redactOnVm: Boolean(projectSecrets?.redact.length),
														eligible: async () =>
															!(await hooks.toolHooksConfigured()),
														store: boxToolStore,
													},
												}
											: {}),
									},
								}
							: {}),
						deadline: step?.waitDeadlineAt ?? Date.now() + 10 * 60_000,
						signal: abort.signal,
						redact: () => redact,
						addRedaction: (value) => {
							if (!redact.includes(value)) redact.push(value);
						},
						hasItem: (id) =>
							items.some((item) => item.id === `${turn.id}:${id}`),
						toolName: (id) => {
							const found = items.find(
								(item) => item.id === `${turn.id}:${id}`,
							);
							return found?.kind === "dynamicToolCall" ? found.tool : undefined;
						},
						onEvent: async (event) => {
							if (
								event.type === "text-delta" ||
								event.type === "reasoning-delta" ||
								event.type === "tool-call"
							)
								timing?.mark("firstToken");
							items = applyApiProgress(items, turn.id, event);
							if (event.type === "finish") {
								progress.offer(items);
								await progress.drain();
							} else progress.stream(items, progress.window());
						},
						onPlan: (plan) => {
							items = applyPlanUpdate(items, turn.id, {
								plan: plan.map(({ step: text, status }) => ({
									step: text,
									status,
								})),
							});
							progress.offer(items);
						},
						inbox: takeSentMessages,
						...(claudeToolTime ? { toolTime: claudeToolTime } : {}),
					}).catch((error: unknown) => {
						throw ySquared ? ySquaredClaudeFailure(error) : error;
					}),
				);
				// The step is short (it follows the run's feed), so its grace
				// rarely elapses here: the chat's object may pause the VM while
				// the turn is parked, from the quiet noted here
				// (claude-parked-turn.ts).
				const quiet = bridgedPause?.quiet();
				if (quiet !== undefined && execution?.vm)
					noteClaudeTurnQuiet(turn.id, {
						vm: execution.vm,
						userId: owner.userId,
						since: quiet?.since ?? null,
						toolEnded: quiet?.toolEnded ?? false,
					});
				messages = withMessagesSentDuringRun(
					claudeResult.messages,
					sentDuringRun,
				);
				result = { ...claudeResult, messages };
			} else
				result = await timed("turn:runAgent", async () =>
					runAgent({ ...agentInput, messages }),
				);
			// The step succeeded: a later failure gets its own retries.
			if (retried) {
				retryCleared = withRouteRetries(turn.failover, route, 0);
				retried = 0;
			}
		}
		// A turn that ran no tool able to change files has nothing to commit:
		// it ends at its answer, without waiting for a checkout still being
		// prepared (its tools would have waited for it, and the metadata guard).
		// Y² has no workspace: whatever it ran, nothing there changed or commits.
		const answerOnly = () =>
			ySquared || (!claudeCode && !turnMayHaveChangedWorkspace(items, turn.id));
		// An early first request: the step ends only once its checkout is
		// ready (a workspace failure fails the turn as before, and the turn's
		// code point exists) and the UserPromptSubmit check passed. Feedback
		// the check gave reaches the model in a next step. A turn that only
		// answered does not wait: the chat's journaled configuration had no
		// UserPromptSubmit hook (or the request would not have gone early),
		// and it ran nothing on the machine.
		if (earlyPromptCheck && (checkoutReady || !answerOnly())) {
			failureStage = "workspace";
			// The reply is already shown: a Stop must not wait out a slow VM call
			// (machine calls ignore the signal; preparation stops at its next check).
			// Tools already waited for ~/memory; committing needs the checkout.
			await untilAborted(checkout(), abort.signal);
			failureStage = "model";
			const submitted = await untilAborted(earlyPromptCheck, abort.signal);
			if (submitted.block) throw new LifecycleHookRefusal(submitted.reason);
			const withFeedback = hooks.drain(messages);
			if (withFeedback !== messages) {
				messages = withFeedback;
				if (!Array.isArray(result) && result.outcome === "completed") {
					await saveCheckpoint();
					coordinated = false;
					leaseCarried = true;
					return "continue";
				}
			}
		}
		// A Stop hook runs in the checkout; a turn that only answered does not
		// wait for one being prepared when the journaled configuration has none.
		const stopHooks = async (history: ModelMessage[]) =>
			!checkoutReady && answerOnly() && (await hooks.stopConfigured()) === false
				? false
				: hooks.stop(history);
		while (!step && (await stopHooks(messages))) {
			messages = hooks.drain(messages);
			await saveCheckpoint();
			result = await runAgent({ ...agentInput, messages });
		}
		if (
			step &&
			!Array.isArray(result) &&
			result.outcome === "completed" &&
			(await stopHooks(messages))
		) {
			messages = hooks.drain(messages);
			await saveCheckpoint();
			coordinated = false;
			leaseCarried = true;
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
			leaseCarried = true;
			return "continue";
		}
		// Background command exits already announced or seen reach their cards; new exits wake the chat later.
		// A turn that only answered does not wait for a machine still being
		// prepared to read them (an earlier turn's dev server, say).
		// Y² ran no command and has no machine to read them from.
		const background =
			!ySquared && (checkoutReady || !answerOnly())
				? await withBackgroundCommandNotices({
						workspace,
						sessionId: owner.id,
						items,
						messages,
						claim: false,
					}).catch(() => null)
				: null;
		if (background?.changed) items = background.items;
		// No background command of this chat runs any more: its VM gets the
		// short idle timeout back unless another chat's command runs on it.
		if (!ySquared && (checkoutReady || !answerOnly()))
			await settleIdleTimeoutAfterTurn({ workspace, items });
		// A push card answered during the last step still gets its notice.
		const pushResults = await withPushResultNotices({
			userId: owner.userId,
			sessionId: owner.id,
			items,
			messages,
		}).catch(() => null);
		if (pushResults) items = pushResults.items;
		// A model stop is not proof that detached verification finished. Re-observe at the publication boundary.
		const historyBeforeCompletion = messages;
		const finalHistory = ySquared
			? messages
			: await withBackgroundCommandContext({
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
				leaseCarried = true;
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
					item.kind === "secretRequest" ||
					item.kind === "userQuestion",
			)
		)
			throw new IncompleteAgentTurn("missing-final-result");
		// Goal mode: while the goal is active the model goes back with the
		// audit notice, until it marks the goal complete or blocked or a
		// deterministic stop (deadline, idle turns, continuation cap) ends it.
		const heldGoal = goalOfTurn(items, turn.id);
		if (heldGoal && !abort.signal.aborted) {
			const cards = turnToolCards(items, turn.id);
			const { goal, step: goalStep } = nextGoalStep(heldGoal.state, {
				nowMs: Date.now(),
				toolCalls: heldGoal.toolMark < 0 ? null : cards - heldGoal.toolMark,
			});
			const sending =
				goalStep.kind === "continue" || goalStep.kind === "wrapUp";
			items = withGoalNotice(
				items,
				goalNoticeItem(turn.id, goal, sending ? cards : heldGoal.toolMark),
			);
			progress.offer(items);
			if (sending) {
				messages = [...messages, { role: "user", content: goalStep.text }];
				await saveCheckpoint();
				coordinated = false;
				leaseCarried = true;
				// A durable step ends and the next one runs the notice; the local
				// worker runs it as the same turn's next attempt.
				return step ? "continue" : { failedOver: { ...turn, messages, items } };
			}
			await saveCheckpoint();
		}
		if (attemptLoop) {
			const next = await timed("turn:attemptLoop", () =>
				attemptLoop.afterAttempt({
					messages,
					items,
					waitUntil: attemptWaitUntil(),
				}),
			);
			if (next.items) items = next.items;
			if (next.kind !== "finished") {
				// The next step waits on the checker or runs the next attempt.
				if (next.kind === "run" && next.messages) messages = next.messages;
				await saveCheckpoint();
				coordinated = false;
				leaseCarried = true;
				return "continue";
			}
			messages = next.messages;
			await saveCheckpoint();
		}
		// Decided once the answer is final: tools no longer run.
		const changedWorkspace = !answerOnly();
		// What the agent committed to ~/memory this turn, shown after its answer
		// (only a tool writes it).
		if (memory && changedWorkspace)
			items = await timed("turn:memorySaved", () =>
				memory.recordSaved(items, turn.id),
			);
		// A subagent's work reaches its parent as a report (a writer's as a
		// patch and ref), never as a commit or a published branch.
		// Y changes no files itself, but builders' patches were applied to its
		// checkout since its last commit (src/domain/y-agent.ts): it commits
		// whatever is there; an empty commit is skipped.
		const commits = !owner.agentRole && (changedWorkspace || yAgent);
		failureStage = commits ? "commit" : "saving";
		// The answer is done: the chat shows "Saving changes…" (the composer
		// offers Send, which waits for the commit, instead of Stop).
		if (commits) {
			items = [...withoutSavingChanges(items), savingChangesItem(turn.id)];
			progress.offer(items);
		}
		// Fence even commands whose acknowledgement was lost before it reached the durable cards.
		// Unlike best-effort cancellation on failure, a commit requires a confirmed stop.
		// A turn that commits nothing (a subagent) keeps its finished answer if the
		// stop cannot be confirmed.
		// Commands start only from this turn's tools.
		if (execution && changedWorkspace) {
			const stop = () =>
				stopApiTurnCommands(execution as AgentToolWorkspace, turn.id);
			if (commits) await timed("turn:stopCommands", stop);
			else
				await timed("turn:stopCommands", () =>
					stop().catch((error) =>
						console.warn("turn:stopCommands unconfirmed", {
							turnId: turn.id,
							...apiTurnFailureClassification(error),
						}),
					),
				);
		}
		// The turn's changes are committed here, before it shows as done (the
		// commit keeps the work); the push and pull request follow right after.
		// A turn that ran no tool able to change files commits nothing: its
		// answer ends it (a later turn's commit takes anything else left).
		// The commit and its publication stop with the turn until the turn is
		// being marked done; from then on its publication (which runs after the
		// turn shows as done) is not cut off by a late abort of this step, such
		// as a heartbeat that raced the final writes.
		const publicationStop = new AbortController();
		const stopPublication = () => {
			if (!finalizing) publicationStop.abort(abort.signal.reason);
		};
		if (abort.signal.aborted) stopPublication();
		else abort.signal.addEventListener("abort", stopPublication);
		const committed = commits
			? await timed("turn:commit", () =>
					commitSessionTurn(
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
						publicationStop.signal,
					),
				)
			: undefined;
		if (commits) items = withoutSavingChanges(items);
		if (committed?.notice)
			items = [
				...items.filter((item) => item.id !== `${turn.id}:publication`),
				{
					kind: "notice",
					id: SessionItemId(`${turn.id}:publication`),
					message: committed.notice,
				},
			];
		// "Opening pull request…" shows with the answer, until GitHub answers.
		if (committed?.publish)
			items = [
				...items.filter(
					(item) => item.id !== pullRequestHandoffItemId(turn.id),
				),
				openingPullRequestItem(turn.id, Date.now()),
			];
		abort.signal.throwIfAborted();
		finalizing = true;
		failureStage = "coordination";
		if (!(await coordinateConversationTurn("release", control)))
			throw new Error(
				"Conversation coordination lease was lost before completion.",
			);
		coordinated = false;
		failureStage = "saving";
		workspaceReuse?.forget();
		await progress.drain();
		// Set before the write: a renewal racing it may see the row completed.
		// finalize itself refuses a turn whose cancel was requested.
		turnSettled = true;
		// The turn ends on a card only the person can answer (question, secret
		// request, push approval, plan): tell the project's crew now, so Y²
		// does not see the thread as finished if the chat object's own copy of
		// the transcript cannot say what it waits on. The crew merges it into
		// the settle note. No database read; a port, so a box turn too.
		const waitingOn = chatWaitingOn(items, "completed");
		if (waitingOn && projectY?.enabled && owner.projectId && !ySquared)
			noteCrewWaiting({
				sessionId: owner.id,
				userId: owner.userId,
				projectId: owner.projectId,
				ySquaredId: projectY.ySquaredId,
				waitingOn,
			});
		const saved = await timed("turn:finalize", () =>
			finalizeApiTurn(turn, "completed", items),
		);
		// Bounded: a slow provider never holds the turn's settled state back.
		await Promise.race([
			releaseBoxTools(),
			new Promise((resolve) => setTimeout(resolve, 3_000)),
		]);
		if (saved !== "completed") {
			// A stop that raced completion still hands off what was committed.
			if (saved === "cancelled" && committed?.publish)
				await finishPullRequestHandoff(
					turn,
					committed.publish,
					replaceSettledTurnItem,
				);
			abort.abort();
			return saved === "cancelled" ? "cancelled" : "failed";
		}
		await publishProgress("completed").catch(() => {});
		// The turn shows as done; its branch is pushed and its draft pull
		// request opened now, and the chat's item becomes the link (live, over
		// the progress stream). A cut-off handoff leaves the commit, which the
		// next turn pushes.
		if (committed?.publish)
			await timed("turn:publication", () =>
				finishPullRequestHandoff(
					turn,
					committed.publish as NonNullable<typeof committed.publish>,
					replaceSettledTurnItem,
				),
			);
		// The writer lives as long as the chat: an idle one waits for the next
		// message (until its idle TTL); one still working finishes its round
		// and its report wakes Main.
		await memory?.afterTurn(turn.id);
		await recordCloudProjectReport(owner, turn.id, items).catch(() => {
			console.warn(
				"Completed turn saved, but its project report needs recovery.",
			);
		});
		if (owner.parentSessionId && !isSideChat(owner)) {
			const finalText = items
				.slice(lastUser + 1)
				.filter((item) => item.kind === "agentMessage")
				.map((item) => item.text)
				.join("\n");
			const eventId = await saveAgentTaskResultAndEvent({
				sessionId: owner.id,
				turnId: turn.id,
				eventType: "completed",
				// Only subagents reach here: a role-less child is refused above.
				summary: await subagentReport({
					machines: unscopedMachines,
					session: owner as AgentSessionRecord,
					items,
					outcome: "finished",
					text: `${finalText.slice(-9000) || "(no final report)"}${
						owner.agentRole === "checker" && hasCheckerFinalNotice(messages)
							? `\n${CHECKER_FORCED_FINAL_MARK}`
							: ""
					}`,
					roleModels: fusionRoleModels,
					thinLead: fusionThinLead,
					applyToThread: yVariant,
					...(evaluation
						? {
								deps: {
									chargeUsage: (usage: ApiTokenUsage, key: string) =>
										recordEvaluationUsage(
											evaluation as EvaluationRun,
											`${turn.id}:${key}`,
											usage,
										),
								},
							}
						: {}),
				}),
			});
			if (eventId) await enqueueAgentTaskEvent(eventId).catch(() => {});
		}
		await startQueuedUserTurn(
			queueMachines,
			turn.user_id,
			turn.session_id,
		).catch(() => {});
		await deliverHeldReports(owner.id, owner.parentSessionId, ports);
		return "completed";
	} catch (error) {
		workspaceReuse?.forget();
		await progress.drain().catch(() => {});
		// A deploy replaced this Worker mid-step: the step is resumed on the new
		// version from its checkpoint (executor.ts alarm), never failed. The
		// provider stream may report only "Model run cancelled" after the abort.
		const platformRestart = [error, abort.signal.reason].find((cause) =>
			isPlatformRestart(cause),
		);
		if (platformRestart) {
			console.warn("Turn step interrupted by a platform reset; it resumes.");
			throw platformRestart;
		}
		// The step's soft deadline passed while its model call was still running and
		// no tool had started: nothing ran, so the step ends and the next one samples
		// again from the last checkpoint. The turn does not fail.
		if (
			softStop.signal.aborted &&
			!claudeCode &&
			!abort.signal.aborted &&
			failureStage === "model" &&
			!failedAttempt?.inFlight &&
			!progressFailed &&
			!coordinationFailure &&
			!heartbeatFailed
		) {
			try {
				const partial = failedAttempt?.uncommittedIds ?? [];
				if (partial.length)
					items = applyApiProgress(items, turn.id, {
						type: "retract",
						ids: step
							? partial.map((id) => `step-${step.index}:${id}`)
							: [...partial],
					});
				if (failedAttempt?.droppedStepSaved) messages = failedAttempt.committed;
				await checkpointApiTurn(turn, messages, items);
				console.warn("Model step was cut short; it continues.", {
					index: step?.index,
					reason: String(softStop.signal.reason?.message ?? ""),
				});
				// The turn's lease carries over to the next step.
				coordinated = false;
				leaseCarried = true;
				return { failedOver: { ...turn, messages, items } };
			} catch (cause) {
				if (!abort.signal.aborted)
					console.warn("Soft deadline checkpoint failed", {
						...apiTurnFailureClassification(cause),
					});
			}
		}
		// A sidekick's run ended at a compaction to switch models: the same
		// turn continues on the escalation route from the compacted history.
		if (
			error instanceof ModelSwitchAtCompaction &&
			subagentSession &&
			!abort.signal.aborted &&
			!progressFailed &&
			!coordinationFailure
		) {
			try {
				const current = {
					route,
					label: {
						model: route.modelId,
						connection: route.connectionId ?? "Codex",
					},
				};
				// A switch that throws is dropped like an unavailable route: the
				// turn continues where it was, and switches no more this turn.
				const outcome = await completeSidekickModelSwitch({
					userId: turn.user_id,
					sessionId: turn.session_id,
					turnId: turn.id,
					roleModels: fusionRoleModels,
					target: error.target,
					compacted: error.compacted,
					current,
					previous: turnFailover(turn.failover),
					messages,
				}).catch((cause: unknown) => {
					blockSidekickSwitch(turn.id);
					return {
						kind: "kept" as const,
						reason: cause instanceof Error ? cause.message : String(cause),
					};
				});
				if (outcome.kind === "kept")
					console.warn("A sidekick's model switch was dropped.", {
						reason: outcome.reason.slice(0, 200),
					});
				const failover =
					outcome.kind === "switched" ? outcome.failover : undefined;
				if (outcome.kind === "switched") {
					messages = outcome.messages;
					items = [
						...items,
						modelSwitchItem(items, {
							id: `${turn.id}:sidekick-switch-${failover?.switches ?? 1}`,
							state: "switched",
							message: `Switched from ${outcome.from} to ${outcome.to} at a context compaction (${error.target.reason.replace(/[.\s]+$/, "")}).`,
							reason: "sidekick-escalation",
							from: current.label,
							to: {
								...outcome.label,
								key: routeKey(outcome.failover.route),
							},
						}),
					];
				}
				await checkpointApiTurn(turn, messages, items, failover);
				// The turn's lease carries over to the step on the new route.
				coordinated = false;
				leaseCarried = true;
				return {
					failedOver: {
						...turn,
						...(failover ? { failover } : {}),
						messages,
						items,
					},
				};
			} catch (cause) {
				console.warn("A sidekick's model switch failed.", {
					...apiTurnFailureClassification(cause),
				});
			}
		}
		// Every failure's raw cause (redacted) is always logged, production too,
		// and kept on the turn's error item, so the owner can see why it failed.
		// The user-facing message stays the fixed wording.
		const turnCause = failureCause(coordinationFailure ?? error);
		if (!abort.signal.aborted || heartbeatFailed || progressFailed)
			console.warn("API turn failed", {
				stage: coordinationFailure ? "coordination" : failureStage,
				...apiTurnFailureClassification(coordinationFailure ?? error),
				...(turnCause ? { cause: turnCause } : {}),
				// Where a Y² turn reached for a workspace it does not have:
				// frames only (no message text, no user content).
				...(isYSquaredNoWorkspace(coordinationFailure ?? error)
					? { stack: errorStackFrames(error) }
					: {}),
				// Development diagnostics only: messages can contain provider details.
				...(debugTurnErrors() && error instanceof Error
					? {
							debug: `${error.name}: ${error.message}`.slice(0, 400),
							stack: error.stack?.split("\n").slice(0, 6).join(" | "),
						}
					: {}),
			});
		// A provider-side failure moves the turn to its next best route; the
		// switch happens here, between model steps, never inside a stream. A
		// fallback the turn moved to on its own also moves on when its account
		// cannot serve (out of credit, key refused).
		const reason =
			failureStage === "model" &&
			failoverScope &&
			!abort.signal.aborted &&
			!progressFailed &&
			!coordinationFailure
				? (failoverReason(error) ??
					(turnFailover(turn.failover) ? fallbackAccountReason(error) : null))
				: null;
		// A transient failure first runs the step again on the same route, from
		// the same checkpoint a failover would continue from, after a short
		// wait. A step whose tools had started is not repeated here: the
		// failover's runtime note tells the next model to inspect their effects.
		if (
			reason &&
			retriesSameRoute(error, reason) &&
			!failedAttempt?.inFlight &&
			retried < MODEL_STEP_RETRY_DELAYS_MS.length
		) {
			try {
				await abortableDelay(
					MODEL_STEP_RETRY_DELAYS_MS[retried] ?? 0,
					abort.signal,
				);
				const partial = failedAttempt?.uncommittedIds ?? [];
				if (partial.length)
					items = applyApiProgress(items, turn.id, {
						type: "retract",
						ids: step
							? partial.map((id) => `step-${step.index}:${id}`)
							: [...partial],
					});
				if (failedAttempt?.droppedStepSaved) messages = failedAttempt.committed;
				const failover = withRouteRetries(turn.failover, route, retried + 1);
				await checkpointApiTurn(turn, messages, items, failover);
				console.warn("Model step retried on the same route", {
					reason,
					retry: retried + 1,
					...apiTurnFailureClassification(error),
				});
				// The turn's lease carries over to the retried step.
				coordinated = false;
				leaseCarried = true;
				return { failedOver: { ...turn, failover, messages, items } };
			} catch (cause) {
				if (!abort.signal.aborted)
					console.warn("Model step retry failed", {
						...apiTurnFailureClassification(cause),
					});
			}
		}
		// The turn leaves Claude Code here (it moves on, waits for an answer or
		// fails): a CLI still running for it stops, so its trailing output (often
		// an error once its access ended) is never read and it stops working.
		// A stopped turn's commands, the CLI among them, are already stopping.
		if (!abort.signal.aborted) await stopClaudeCodeRun?.();
		let paused: ModelSwitchItem | undefined;
		let exhausted = "";
		// Failover to another connection plans from the database and is not
		// served on a turn runner box (docs/turn-runner-boxes.md): a box turn
		// whose route fails ends with the failure's own message.
		if (
			reason &&
			failoverScope &&
			!abort.signal.aborted &&
			!ports.modelAccess
		) {
			const scope = failoverScope;
			try {
				const plan = await planModelFailover({
					turn,
					reason,
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
						reason,
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
							cause: failureSummary(error),
							resetsAt: subscriptionLimitResetsAt(error),
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
					leaseCarried = true;
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
						cause: failureSummary(error),
						resetsAt: subscriptionLimitResetsAt(error),
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
			: error instanceof SubagentBudgetExhausted
				? `${error.message} The work so far was reported to the parent agent.`
				: coordinationFailure
					? apiTurnFailureMessage("coordination", coordinationFailure)
					: abort.signal.reason instanceof TurnTimeLimitReached
						? TURN_TIME_LIMIT_MESSAGE
						: abort.signal.aborted
							? `Run stopped. ${abort.signal.reason instanceof Error && ["Turn ownership or cancellation state changed.", "Conversation coordination lease was lost.", "Turn heartbeat or coordination service became unavailable."].includes(abort.signal.reason.message) ? `${abort.signal.reason.message} ` : ""}Inspect any in-flight command before continuing.`
							: exhausted
								? (failoverChainFailure(
										items,
										turn.id,
										apiTurnFailureMessage(failureStage, error),
									) ?? apiTurnFailureMessage(failureStage, error) + exhausted) +
									developmentFailureDetail(error)
								: (paused?.message ??
										apiTurnFailureMessage(failureStage, error)) +
									developmentFailureDetail(error);
		// The heartbeat or the room usually notices the user's Stop before progress does.
		const userCancelled =
			abort.signal.reason instanceof ApiTurnCancelled ||
			(abort.signal.aborted &&
				(await apiTurnCancelRequested(turn).catch(() => false)));
		items = userCancelled
			? withStoppedNotice(items, turn.id)
			: [
					...items,
					paused ?? {
						kind: "error",
						id: SessionItemId(`${turn.id}:error`),
						message: failureMessage,
						...(turnCause ? { cause: turnCause } : {}),
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
		const settledState =
			userCancelled ||
			(abort.signal.aborted && !timedOut && !heartbeatFailed && !progressFailed)
				? "cancelled"
				: "failed";
		// Tool calls of the cut-off step are not in the last checkpoint; the next
		// turn closes them with stand-in results instead of forgetting them.
		const saved = await (failedAttempt?.inFlight
			? finalizeApiTurn(turn, settledState, items, failedAttempt.inFlight)
			: finalizeApiTurn(turn, settledState, items));
		// Bounded: a slow provider never holds the turn's settled state back.
		await Promise.race([
			releaseBoxTools(),
			new Promise((resolve) => setTimeout(resolve, 3_000)),
		]);
		if (saved)
			await publishProgress?.(saved === "cancelled" ? "idle" : "failed").catch(
				() => {},
			);
		if (saved && fusionLead)
			await retireLeadSidekicks(
				unscopedMachines,
				fusionLead,
				saved === "cancelled" ? "Main was stopped" : "Main's turn failed",
			).catch(() => {});
		if (saved === "failed" && !sideConversation) {
			// A subagent still reports: what it said so far and, for a writer,
			// the partial patch (its work in progress is committed for it).
			const summary = subagentSession
				? await subagentReport({
						machines: unscopedMachines,
						session: subagentSession,
						items,
						outcome:
							error instanceof SubagentBudgetExhausted
								? "budget exhausted"
								: "failed",
						roleModels: fusionRoleModels,
						thinLead: fusionThinLead,
						applyToThread: yVariant,
						text: [
							failureMessage,
							items
								.filter((item) => item.kind === "agentMessage")
								.map((item) => item.text)
								.join("\n")
								.slice(-6000),
						]
							.filter(Boolean)
							.join("\n\n"),
					}).catch(() => failureMessage)
				: failureMessage;
			const eventId = await saveAgentTaskResultAndEvent({
				sessionId: turn.session_id,
				turnId: turn.id,
				eventType: "failed",
				summary,
			});
			if (eventId) await enqueueAgentTaskEvent(eventId).catch(() => {});
		}
		// Messages sent during the turn outlive its stop or failure: the first starts the next turn.
		if (saved) {
			await startQueuedUserTurn(
				queueMachines,
				turn.user_id,
				turn.session_id,
			).catch(() => {});
			await deliverHeldReports(
				turn.session_id,
				subagentSession?.parentSessionId,
				ports,
			);
		}
		abort.abort();
		return saved === "cancelled" ? "cancelled" : "failed";
	} finally {
		// The VM's memory token goes when the step ends (completed, failed,
		// cancelled or continued in a later step) rather than at expiry, with
		// any earlier step's; a later step clones with a new one.
		// Tools wait for the clone; a step that called none may end while it
		// runs, so it is awaited before its token is released.
		forgetLiveTurn();
		thinkingPause?.dispose();
		clearTimeout(softTimer);
		// A turn that ended at its answer lets its preparation finish, bounded
		// (a VM that does not answer); a stopped step's ends at its next check.
		if (preparation && !abort.signal.aborted)
			await settledWithin(preparation, PREPARATION_SETTLE_MS, abort.signal);
		await memoryCloning?.catch(() => {});
		const cloned = memoryCloned;
		const vm = execution;
		await memoryLoading
			.then(async (memory) => {
				if (!memory) return;
				await cloned?.catch(() => {});
				await memory.releaseVm(cloned ? vm : undefined);
			})
			.catch(() => {});
		await machineGitPrepared?.catch(() => {});
		await machineGit?.releaseVm(machineGitPrepared ? vm : undefined);
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
/** The first frames of an error's stack, without its message (no user content). */
function errorStackFrames(error: unknown, frames = 10) {
	if (!(error instanceof Error) || !error.stack) return undefined;
	return error.stack
		.split("\n")
		.filter((line) => /^\s+at /.test(line))
		.slice(0, frames)
		.map((line) => line.trim())
		.join(" | ");
}

/**
 * A Y² turn on Claude whose runner box could not be reached says so plainly
 * (and may fail over); every other failure is its own. Nothing a runner box
 * said is shown: its transport errors talk of commands Y² never runs.
 */
function ySquaredClaudeFailure(error: unknown) {
	if (error instanceof ClaudeRunnerTransportFailure) {
		console.warn("Y²'s Claude runner could not be reached.", {
			operation: error.operation,
			reason: error.reason,
			httpStatus: error.httpStatus,
		});
		return new YSquaredClaudeRunnerUnreachable();
	}
	return error;
}

/** A turn's workspace that every caller is refused (a chat without a machine). */
function refusedApiTurnWorkspace(
	reason: string,
): ReturnType<typeof deferredApiTurnWorkspace> {
	const refused = () => Promise.reject<AgentToolWorkspace>(new Error(reason));
	return Object.assign(refused, {
		checkedOut: refused,
		pinnedBase: async () => null,
		plannedDirectory: async () => null,
		pinnedBaseFile: async () => null,
	});
}

function turnRecordsRequests(
	turnId: string,
	userId: string,
	isDevEvalUser: TurnPorts["isDevEvalUser"],
) {
	return devEvalUsersEnabled()
		? turnMemo(`${turnId}:records-requests`, () => isDevEvalUser(userId))
		: Promise.resolve(false);
}

function turnHarnessVariant(
	turnId: string,
	userId: string,
	harnessVariantForUser: TurnPorts["harnessVariantForUser"],
) {
	return devEvalUsersEnabled()
		? turnMemo(`${turnId}:harness-variant`, () => harnessVariantForUser(userId))
		: Promise.resolve(PRODUCT_HARNESS_VARIANT);
}

/**
 * The tools a turn offers: its surface's tools, the user's MCP servers,
 * plugin skills, hosted web search and web_fetch, wrapped in lifecycle
 * hooks, secret redaction and (in root chats) the project-secret request.
 */
function turnTools(input: {
	surfaceTools: ToolSet;
	mcp: Awaited<ReturnType<typeof connectMcpTools>>;
	plugins: Awaited<ReturnType<TurnPorts["enabledPluginSkillIndex"]>>;
	/** A listed skill's body, read when the agent asks for it. */
	pluginSkillBody: NonNullable<Parameters<typeof pluginSkillTools>[1]>;
	webSearch: ToolSet;
	webFetch: ToolSet;
	hooks: ReturnType<typeof harnessLifecycleHooks>;
	rootChat: boolean;
	projectSecrets: Awaited<
		ReturnType<TurnPorts["loadAgentProjectSecrets"]>
	> | null;
	redact: readonly string[];
	/** save_project_environment, in a person's root chats (not evaluations). */
	environmentSetup: ToolSet;
	/** request_push_approval, in a person's root chats. */
	pushApproval: ToolSet;
	/** save_project_secret, in a person's root chats in a project. */
	saveSecret: ToolSet;
	/** describe_secret, in a person's root chats in a project that receives secrets. */
	describeSecret: ToolSet;
	/** canvas, in a person's root chats. */
	canvas: ToolSet;
}) {
	const { mcp, hooks, rootChat, projectSecrets, redact } = input;
	const withMcp = {
		...input.surfaceTools,
		...mcp.tools,
		...pluginSkillTools(input.plugins, input.pluginSkillBody),
		...input.webSearch,
		...input.webFetch,
	};
	// Only a person in a root chat can paste a secret into the card.
	const secretTools =
		rootChat && projectSecrets
			? secretRequestTools(projectSecrets.names.map(({ name }) => name))
			: {};
	const questionTools = rootChat ? askUserTools() : {};
	// Large MCP setups are searched and called through two fixed tools; the
	// real tools they run keep their hooks and redaction.
	return mcpToolSurface({
		tools: hooks.wrap(
			withRedactedResults(
				{
					...withMcp,
					...secretTools,
					...questionTools,
					...input.canvas,
					...input.environmentSetup,
					...input.pushApproval,
					...input.saveSecret,
					...input.describeSecret,
				},
				redact,
			),
		),
		catalog: mcp.catalog,
		purposes: mcp.purposes,
	});
}

/**
 * A lean builder's tool list in a fixed order, so it is byte-stable within
 * a chat: run_code first in code mode primary, the surface's own tools, the
 * workflow tools (agent, agent_send), web search, request_project_secret,
 * then the rest (MCP,
 * plugins, run_code in code mode on) in insertion order.
 */
function inLeanToolOrder(
	tools: ToolSet,
	groups: {
		surface: readonly string[];
		webSearch: readonly string[];
		runCodeFirst: boolean;
	},
): ToolSet {
	const leading = [
		...(groups.runCodeFirst ? [CODE_MODE_TOOL] : []),
		...groups.surface,
		AGENT_TOOL,
		AGENT_SEND_TOOL,
		...groups.webSearch,
		REQUEST_PROJECT_SECRET_TOOL,
		ASK_USER_TOOL,
		REQUEST_PUSH_APPROVAL_TOOL,
	].filter((name) => name in tools);
	const names = [
		...new Set([
			...leading,
			...Object.keys(tools).filter((name) => !leading.includes(name)),
		]),
	];
	return Object.fromEntries(names.map((name) => [name, tools[name]]));
}

/**
 * Adds run_code (code mode) to a lean builder's final tool set. Its programs
 * call the tools above as they are, already wrapped in hooks and redaction,
 * so every inner call is checked like a direct one; run_code's
 * own result is redacted again on the way out.
 */
function withCodeMode(
	tools: ToolSet,
	codeMode: {
		signal: AbortSignal;
		sessionId: string;
		turnId: string;
		toolCallPrefix?: string;
		redact: readonly string[];
		mode: "on" | "primary";
		deferred: readonly string[];
		callable: readonly string[];
	} | null,
): ToolSet {
	if (!codeMode) return tools;
	const runCode = codeModeTool({ tools, ...codeMode });
	if (!runCode) return tools;
	const offered = withRedactedResults(
		{ [CODE_MODE_TOOL]: runCode },
		codeMode.redact,
	);
	if (codeMode.mode !== "primary") return { ...tools, ...offered };
	return primaryCodeModeTools(offered, tools);
}

/** The system prompt: the builder's instructions, then memory's. */
function turnInstructions(
	agent: Parameters<typeof agentTurnInstructions>[0],
	memory: { instructions: string } | null,
	/** The project has imported local sessions on this machine. */
	handoffHistory = false,
) {
	return `${agentTurnInstructions(agent)}${memory ? `\n${memory.instructions}` : ""}${handoffHistory ? `\n${HANDOFF_HISTORY_INSTRUCTIONS}` : ""}`;
}

function modelSwitchItem(
	items: readonly SessionItem[],
	input: {
		id: string;
		state: ModelSwitchItem["state"];
		message: string;
		reason: ModelSwitchItem["reason"];
		from: ModelSwitchItem["from"];
		to: ModelSwitchItem["to"];
		cause?: string;
		resetsAt?: number;
	},
): ModelSwitchItem {
	const { resetsAt, ...fields } = input;
	const usageBefore = [...items]
		.reverse()
		.find((item) => item.kind === "userMessage")?.apiUsage;
	return {
		kind: "modelSwitch",
		...fields,
		id: SessionItemId(input.id),
		...(usageBefore ? { usageBefore } : {}),
		...(resetsAt !== undefined ? { resetsAt } : {}),
	};
}

/**
 * Settles with `work`, or rejects with the signal's reason once it aborts;
 * the work itself keeps running to its own end.
 */
export function untilAborted<T>(
	work: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	if (signal.aborted) {
		work.catch(() => {});
		return Promise.reject(signal.reason);
	}
	return new Promise<T>((resolve, reject) => {
		const stop = () => reject(signal.reason);
		signal.addEventListener("abort", stop, { once: true });
		work
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", stop));
	});
}

/** How long a finished step waits for a preparation its turn did not need. */
const PREPARATION_SETTLE_MS = 60_000;
/** A failing database renewal stops the turn once it has lasted this long: well inside the 45 s lease. */
const DATABASE_HEARTBEAT_GRACE_MS = 20_000;

/** Waits for `work` to settle, at most `ms` and never past the signal's abort. */
function settledWithin(
	work: Promise<unknown>,
	ms: number,
	signal: AbortSignal,
) {
	return new Promise<void>((resolve) => {
		const timer = setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
		work.then(done, done);
		function done() {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
	});
}

/** Waits `ms`, or rejects with the signal's reason once it aborts. */
function abortableDelay(ms: number, signal: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		const timer = setTimeout(done, ms);
		function done() {
			signal.removeEventListener("abort", stop);
			resolve();
		}
		function stop() {
			clearTimeout(timer);
			reject(signal.reason);
		}
		signal.addEventListener("abort", stop, { once: true });
	});
}

/** A step ran past its 14-minute budget (a hung command or model call), not the turn past some limit. */
const TURN_TIME_LIMIT_MESSAGE =
	"One step took longer than 14 minutes and was stopped. Work so far is preserved; inspect any in-flight command, then send a message to continue.";

class TurnTimeLimitReached extends Error {
	constructor() {
		super("Turn time limit reached.");
		this.name = "TurnTimeLimitReached";
	}
}

/** YTIMESY_DEBUG_TURN_ERRORS=1, honoured only in development: provider details can leak. */
function debugTurnErrors() {
	return (
		process.env.YTIMESY_DEBUG_TURN_ERRORS === "1" && isDevelopmentEnvironment()
	);
}

/** Development diagnostics only (YTIMESY_DEBUG_TURN_ERRORS=1): the provider's own error. */
function developmentFailureDetail(error: unknown) {
	if (!debugTurnErrors() || !(error instanceof Error)) return "";
	const inner = (error as { providerError?: unknown }).providerError;
	const detail =
		inner instanceof Error
			? `${inner.name}: ${inner.message} ${JSON.stringify((inner as { responseBody?: unknown }).responseBody ?? "")}`
			: inner
				? JSON.stringify(inner)
				: `${error.name}: ${error.message}`;
	return ` [debug ${detail.slice(0, 600)}]`;
}
