/// <reference path="../../../.ytimesy/edge-executor-runtime.d.ts" />
import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";
import { z } from "zod";
import {
	BACKGROUND_EXIT_PATH,
	BACKGROUND_EXIT_TOKEN_HEADER,
	backgroundExitRequest,
	verifyBackgroundExitToken,
} from "../../domain/background-exit-wake";
import { backgroundJob } from "../../domain/background-job";
import { readBoundedRequestBody } from "../../domain/bounded-request-body";
import type { McpCallResult } from "../../domain/claude-code-mcp";
import {
	CLAUDE_CODE_FEED_PATH,
	CLAUDE_FEED_MAX_MESSAGE,
	CLAUDE_FEED_PING,
	CLAUDE_FEED_PROTOCOL,
	CLAUDE_FEED_SOCKET_TAG,
	type ClaudeFeedMode,
	type ClaudeFeedState,
	claudeFeedEnabled,
	claudeFeedMessage,
	claudeInboxKey,
	type FeedTold,
	feedLastHeard,
	feedSyncFrames,
	feedWakeAt,
	isUrgentFeedLine,
} from "../../domain/claude-feed";
import {
	claudeFeedPreview,
	livePreviewFrame,
} from "../../domain/claude-feed-preview";
import {
	CLAUDE_PARKED_RENEW_MS,
	CLAUDE_PARKED_ROOM_LEASE_MS,
	claudeStepWake,
	nextParkedVmQuiet,
	parkedTurnRenewal,
	parkedVmPauseAt,
	parkedVmPauseCheck,
} from "../../domain/claude-parked-turn";
import { claimConversationStep } from "../../domain/conversation-step-receipts";
import { turnControlSchema } from "../../domain/conversation-turn-control";
import { verifyDeliveryRequest } from "../../domain/delivery-auth";
import { environmentWorkflowRequest } from "../../domain/environment-workflow";
import { proxyGithubGit } from "../../domain/github-git-proxy";
import { WorkspaceId } from "../../domain/ids";
import { LIVE_SOCKET_PONG } from "../../domain/live-progress-socket";
import {
	modelConversationName,
	routeModelConversationStep,
} from "../../domain/model-conversation-routing";
import {
	STEP_BUDGET_MS,
	type WorkflowStep,
	type WorkflowTurn,
	workflowTurnSchema,
} from "../../domain/model-workflow";
import type { SessionItem, SessionTurnStatus } from "../../domain/session-item";
import {
	boxSocketMessage,
	TURN_BOX_PATHS,
} from "../../domain/turn-box-protocol";
import {
	isEdgeOutage,
	isTransientInfrastructureFailure,
	shouldRetryStep,
	stepRetryDelayMs,
} from "../../domain/turn-interruption";
import {
	parseHubNote,
	settledHubTurnStatus,
	userHubEnabledFor,
} from "../../domain/user-hub";
import { crewNoteFromItems, crewProjectFor } from "../../domain/y-squared-crew";
import { BUILD_ID } from "../../lib/build-id";
import { socketPair } from "../../realtime/socket-upgrade";
import {
	ConversationRoom,
	isRealtimeRoute,
	routeRealtimeRequest,
} from "../../realtime/worker";
import { activeTurnHistory } from "../adapters/active-turn-history";
import {
	type ApiTurn,
	abandonApiTurn,
	apiTurnLeaseFreshSql,
	cancelWaitingApiTurn,
	keepTurnItemsInChat,
	otherRunningTurnOnMachine,
	refreshWaitingApiTurns,
	renewParkedClaudeTurn,
	turnPastDeadlineSql,
} from "../adapters/api-turns";
import {
	backgroundJobId,
	withBackgroundJobDispatcher,
} from "../adapters/background-job-dispatch";
import {
	ClaudeRunnerPlacement,
	withClaudeRunnerPlacement,
} from "../adapters/claude-runner-placement";
import {
	probeCodexEgress,
	withCodexSubscriptionEgress,
} from "../adapters/codex-subscription-transport";
import {
	wakeConversationProgress,
	withConversationProgressWake,
} from "../adapters/conversation-progress-wake";
import { storeTurnMessages } from "../adapters/conversation-recovery";
import { withConversationTurnCoordinator } from "../adapters/conversation-turn-control";
import { readChatCrewScope } from "../adapters/crew-facts";
import { database } from "../adapters/database";
import { withDatabaseScope } from "../adapters/database-scope";
import { registerAuthEmailBinding } from "../adapters/email";
import { withExecutorBinding } from "../adapters/executor-fetch";
import { readFreestyleApiKey } from "../adapters/freestyle/api-key";
import {
	isCutConnection,
	isPlatformRestart,
} from "../adapters/freestyle/provider-retry";
import { createFreestyleWorkspaceMachines } from "../adapters/freestyle/workspace-machines";
import { registerMemoryEmbeddings } from "../adapters/memory-embeddings";
import { registerMemoryRepos } from "../adapters/memory-repos";
import { withConversationPublisher } from "../adapters/realtime-delivery";
import { createTurnBoxEdgeOps } from "../adapters/turn-box-edge";
import { withTurnHistoryMirror } from "../adapters/turn-history-mirror";
import { turnStartRequest } from "../adapters/turn-start";
import { relayConversationDeliveriesOnce } from "../jobs/conversation-delivery";
import {
	executeModelStep,
	executeWorkflowRequest,
	type WorkflowStepClaim,
} from "../jobs/model-workflow-executor";
import { pendingClaudeCodeCalls } from "../services/claude-code-bridge";
import type { ClaudeCodeFeed } from "../services/claude-code-runner";
import {
	CLAUDE_STEP_PAUSE_MS,
	claudeTurnRedaction,
	forgetClaudeTurn,
	registerClaudeTurn,
	takeClaudeStepPause,
	takeClaudeTurnQuiet,
} from "../services/claude-step-pause";
import { provideCodeModeWasmModule } from "../services/code-mode-sandbox";
import { abortLiveTurn } from "../services/live-turn-abort";
import { alertCronFailure } from "../services/operational-alerts";
import { timed, withStepTrace } from "../services/step-timing";
import {
	adoptThinkingPause,
	attemptThinkingPause,
	pausedForThinkingAt,
	pauseVmWhileThinkingEnabled,
	THINKING_PAUSE_GRACE_MS,
} from "../services/thinking-pause";
import {
	admitQueuedTurns,
	runBackgroundJob,
	startBackgroundJob,
	startClaimedTurn,
} from "./background-jobs";
import {
	answerClaudeCodeMcp,
	CLAUDE_CODE_MCP_PATH,
	isClaudeCodeEdgePath,
	routeClaudeCodeEdge,
	verifiedClaudeFeedGrant,
	verifiedClaudeRelayGrant,
} from "./claude-code-routes";
import { SqliteClaudeFeed } from "./claude-feed-storage";
import {
	CLAUDE_RELAY_CALL_PATH,
	CLAUDE_RELAY_CALL_TAG,
	ClaudeRelay,
	claudeRelayCallTag,
	isClaudeRelayBoxMessage,
	relayCallMessage,
} from "./claude-relay";
import { SqliteClaudeVmQuiet } from "./claude-vm-quiet-storage";
import { SqliteConversationSteps } from "./conversation-step-storage";
import { durableObjectLocation } from "./durable-object-location";
import type { EdgeExecutorEnvironment } from "./environment";
import {
	authorizeGitProxy,
	claimGitProxyGrant,
} from "./github-git-authorization";
import { executorIngressRoute } from "./ingress-route";
import {
	answerMachineGitGrant,
	MACHINE_GIT_GRANT_PATH,
	machineGitHooks,
	machineGitSources,
} from "./machine-git-grant";
import { withEdgeModelEndpoints } from "./model-endpoint";
import { stepFailureCause } from "./step-failure-cause";
import { isTurnBoxEdgePath } from "./turn-box-routes";
import { turnBoxRequestScope } from "./turn-box-scope";
import {
	answerTurnBoxSocketMessage,
	pushCancelToTurnBox,
	TURN_BOX_SOCKET_TAG,
	type TurnBoxSocketAttachment,
} from "./turn-box-socket";
import {
	routeTurnBoxWorker,
	verifiedTurnBoxSocketGrant,
} from "./turn-box-worker";
import { TurnHistoryCache } from "./turn-history-cache";
import { type QueuedTurn, SqliteTurnQueue } from "./turn-queue";
import { logTurnStepSizes } from "./turn-step-sizes";
import { meteredUserId, UsageMeter } from "./usage-meter";

export { BackgroundJobRunner } from "./background-jobs";
export { ProjectEnvironment } from "./project-environment";
export { UserHub } from "./user-hub";

import { SqliteCrewScope } from "./crew-scope-store";

export { YSquaredCrew } from "./y-squared-crew";

import { registerUserHubNotes } from "./user-hub-notes-binding";

// Workers cannot compile WebAssembly from bytes; Wrangler precompiles the
// code-mode sandbox's module, imported only when a program first runs.
provideCodeModeWasmModule(() =>
	import("./quickjs.wasm").then((module) => module.default),
);

// Validate scalar secrets separately: generated ProcessEnv requirements must not
// force application credentials into the deliberately sanitized Git subprocess environment.
const executorSecrets = z.object({
	DATABASE_URL: z.string().min(1),
	DATABASE_SSL_CA: z.string().optional(),
	MODEL_WORKFLOW_SECRET: z.string().min(32),
	MODEL_EXECUTION_ENABLED: z.enum(["0", "1"]).default("0"),
});
// The PR-repair ingress Worker holds only this key, so it can stage repair
// signals but never sign a model step or turn start.
const prRepairIngressSecrets = z.object({
	PR_REPAIR_INGRESS_SECRET: z.string().min(32),
});
const gitProxySecrets = z.object({
	DATABASE_URL: z.string().min(1),
	DATABASE_SSL_CA: z.string().optional(),
	GIT_PROXY_SECRET: z.string().min(32),
	GIT_PROXY_ENABLED: z.literal("1"),
});
// The guest's exit callback is signed with the git proxy's key, which the
// command launch holds (gitProxyConfiguration) and the edge already has.
const backgroundExitSecrets = z.object({
	GIT_PROXY_SECRET: z.string().min(32),
	BACKGROUND_EXECUTION_ENABLED: z.literal("1"),
});
const environmentSecrets = z.object({
	ENVIRONMENT_WORKFLOW_SECRET: z.string().min(32),
	ENVIRONMENT_EXECUTION_ENABLED: z.literal("1"),
});

/** Well inside the 45 seconds after which a turn's lease counts as stale. */
const WAITING_TURN_REFRESH_MS = 15_000;

type ActiveTurn = {
	userId: string;
	sessionId: string;
	turnId: string;
	/** The admitted lease; step receipts are keyed by it. */
	leaseId: string;
	/** The lease Postgres currently accepts writes for; rotated on every resume. */
	currentLeaseId: string;
	stepIndex: number;
	resumes: number;
};

async function resolveModelConversation(step: WorkflowStep) {
	// Also the chat's project and whether it has Y on (and its Y² chat): what
	// the chat object needs to tell its project's crew (y-squared-crew.ts),
	// in the same read, so no thread status ever needs a later one.
	const result = await database().query<{
		userId: string;
		sessionId: string;
		projectId: string | null;
		yEnabled: boolean | null;
		ySquaredId: string | null;
	}>(
		`select t.user_id as "userId",t.session_id as "sessionId",
		   s.project_id as "projectId",
		   -- Helper chats are not threads: they never join the crew.
		   (p.y_enabled and s.parent_session_id is null) as "yEnabled",
		   case when p.y_enabled and s.parent_session_id is null then (select y.id from agent_session y
		     where y.user_id=s.user_id and y.project_id=s.project_id
		       and y.chat_role='y2' and y.archived_at is null limit 1) end as "ySquaredId"
		 from api_turn t join agent_session s on s.id=t.session_id and s.user_id=t.user_id
		 left join project p on p.id=s.project_id and p.user_id=s.user_id
		 where t.id=$1 and t.lease_id=$2 and t.executor='durable-object'`,
		[step.turnId, step.leaseId],
	);
	return result.rows[0] ?? null;
}

const PURGE_TOMBSTONE_TABLE =
	"create table if not exists conversation_tombstone(id integer primary key check(id=1),purged_at integer not null)";

/**
 * What a Claude Code feed socket carries: its grant's turn and, after hello,
 * its run; for a runner that takes inbox frames, what it was last told.
 */
type FeedAttachment = {
	turnId: string;
	run: number | null;
	inbox?: boolean;
	told?: FeedTold | null;
};

/** Fresh turns use DO receipts; legacy Node turns must finish on their original executor. */
export class ModelConversation extends DurableObject<EdgeExecutorEnvironment> {
	private readonly steps: SqliteConversationSteps;
	private readonly claudeFeed: SqliteClaudeFeed;
	/** Claude Code turns on a box: their MCP calls pass through here (claude-relay.ts). */
	private readonly claudeRelay: ClaudeRelay;
	/** The Claude Code turn's VM quiet, for pausing it while parked. */
	private readonly vmQuiet: SqliteClaudeVmQuiet;
	/** A feed step waiting for lines (claude-feed.ts); called when lines or the exit arrive. */
	private readonly feedWaiters = new Set<() => void>();
	/** Lines arrived since the turn's last step started: when the first did, and whether any is urgent. */
	private feedPending: { since: number; urgent: boolean } | null = null;
	private readonly history: TurnHistoryCache;
	private readonly queue: SqliteTurnQueue;
	/** Compute metering for the monthly Cloudflare budget (usage-meter.ts); never throws. */
	private readonly usage: UsageMeter;
	private meteredUserId: string | null = null;
	private readonly room: ConversationRoom;
	/**
	 * The chat was deleted: its tombstone (kept in SQLite across restarts)
	 * refuses every later request, turn, step and alarm, so an in-flight turn
	 * cannot recreate its state after the purge.
	 */
	private purged = false;
	/** The chat's owner (from its identity name, a JSON [userId, sessionId]); null when unreadable. */
	private meterUserId(): string | null {
		return meteredUserId(process.env.YTIMESY_CF_BUDGET_USERS, () =>
			this.identityUserId(),
		);
	}
	private identityUserId(): string | null {
		if (this.meteredUserId) return this.meteredUserId;
		try {
			const name = this.ctx.storage.sql
				.exec<{ name: string }>("select name from conversation_identity")
				.toArray()[0]?.name;
			const parsed: unknown = name ? JSON.parse(name) : null;
			if (Array.isArray(parsed) && typeof parsed[0] === "string")
				this.meteredUserId = parsed[0];
		} catch {
			// Unreadable: this chat is not metered.
		}
		return this.meteredUserId;
	}
	/** Sends unsent usage to the user's hub: throttled, and at once when no turn is active. */
	private async rollupUsage() {
		try {
			const userId = this.meterUserId();
			if (!userId) return;
			await this.usage.rollup(
				(delta) =>
					this.env.USER_HUBS.getByName(
						userId,
						durableObjectLocation(),
					).addUsage(delta),
				!this.activeTurn(),
			);
		} catch (error) {
			console.warn("Usage rollup skipped.", { cause: stepFailureCause(error) });
		}
	}
	/** Whether the budget admitted this turn in degraded mode (longer waits). */
	private turnDegraded(turnId: string) {
		try {
			this.ctx.storage.sql.exec(
				"create table if not exists budget_degraded(turn_id text primary key)",
			);
			return (
				this.ctx.storage.sql
					.exec("select 1 from budget_degraded where turn_id=?", turnId)
					.toArray().length > 0
			);
		} catch {
			return false;
		}
	}
	private bindIdentity(scope: {
		userId: string;
		sessionId: string;
		projectId?: string | null;
		yEnabled?: boolean | null;
		ySquaredId?: string | null;
	}) {
		if (this.purged) return false;
		const name = modelConversationName(scope);
		const existing = this.ctx.storage.sql
			.exec<{ name: string }>("select name from conversation_identity")
			.toArray()[0];
		if (existing && existing.name !== name) return false;
		this.ctx.storage.sql.exec(
			"insert or ignore into conversation_identity(id,name) values(1,?)",
			name,
		);
		if ("yEnabled" in scope) this.rememberCrewScope(scope);
		return true;
	}
	/**
	 * A turn that runs on a turn box (its loop is not here) tells the crew and
	 * the user's hub what this object's own loop would: when it starts and how
	 * it settled (worker RPC from the edge's claim and finalize). Without it
	 * Y² heard nothing of any chat once turns moved to boxes.
	 */
	async noteBoxTurn(input: {
		userId: string;
		sessionId: string;
		turnId: string;
		leaseId: string;
		turnStatus: SessionTurnStatus;
		items: readonly SessionItem[];
	}) {
		if (!this.bindIdentity(input)) return false;
		// Read by the chat at each start (the Y switch is refreshed per turn, as
		// for this object's own turns), and at a settle that has none: a box
		// turn's notes (or one a sweep failed) are often this chat's first word
		// to its crew.
		if (input.turnStatus === "running" || !this.crewScope())
			await this.resolveCrewScope(input);
		this.noteTurnStatus(input, input.turnStatus, input.items);
		// The turn started or settled in Postgres just before this call: the
		// open pages hear it now, not at the next sweep.
		await this.relayToViewers(input, () =>
			withDatabaseScope(
				this.env.HYPERDRIVE.connectionString,
				() => wakeConversationProgress(),
				null,
			),
		).catch(() => {});
		return true;
	}
	/** This chat's own title, read with its crew scope (not stored): a start note's title before the transcript has a message. */
	private chatTitle: string | null = null;
	private readonly crewScopes = new SqliteCrewScope(this.ctx.storage.sql);
	private crewScope() {
		return this.crewScopes.read();
	}
	private rememberCrewScope(scope: {
		projectId?: string | null;
		yEnabled?: boolean | null;
		ySquaredId?: string | null;
	}) {
		this.crewScopes.remember(scope);
	}
	/**
	 * Turns are started with a bare identity (budget admission, /turn-start),
	 * and their steps run here in process, never through the step route that
	 * carries the Y switch: without this read the crew scope was never stored
	 * and no thread ever told its crew anything. Read by the chat, never by the
	 * turn: the turn's lookup matched durable-object leases only, so a box
	 * turn's note (and a first turn a box claimed and handed back) found no
	 * scope and the crew never heard of that thread (crew-facts.ts).
	 */
	private async resolveCrewScope(scope: { userId: string; sessionId: string }) {
		try {
			const resolved = await withDatabaseScope(
				this.env.HYPERDRIVE.connectionString,
				() => readChatCrewScope(scope.userId, scope.sessionId),
				null,
			);
			if (resolved) {
				this.rememberCrewScope(resolved);
				this.chatTitle = resolved.title;
			}
		} catch (error) {
			console.warn("Crew scope was not resolved.", {
				cause: stepFailureCause(error),
			});
		}
	}
	/** Updates for this chat go straight to its room, with no HTTP hop. */
	private withLocalPublisher<T>(
		scope: { userId: string; sessionId: string },
		run: () => Promise<T>,
	) {
		return withConversationPublisher(async (update) => {
			if (
				update.userId !== scope.userId ||
				update.sessionId !== scope.sessionId
			)
				return false;
			const response = await this.room.publish(update);
			// A delta the room cannot merge: the publisher sends the full snapshot.
			if (response.status === 409) return "resync";
			return response.status === 204;
		}, run);
	}
	/**
	 * Runs a box turn's write so that, while someone watches the chat, the
	 * newest saved snapshot goes to its open pages as soon as the write lands:
	 * the same relay the chat's own loop runs after each progress write
	 * (wakeConversationProgress). Without a viewer the write is all there is;
	 * a page that opens later is seeded from Postgres.
	 */
	private relayToViewers<T>(
		scope: { userId: string; sessionId: string },
		run: () => Promise<T>,
	) {
		if (!this.room.watched()) return run();
		return this.withLocalPublisher(scope, () =>
			withConversationProgressWake(
				() => relayConversationDeliveriesOnce(scope.sessionId),
				run,
			),
		);
	}
	private withLocalConversation<T>(
		scope: { userId: string; sessionId: string },
		run: () => Promise<T>,
	) {
		return withConversationTurnCoordinator(
			async (action, turn) => {
				if (turn.userId !== scope.userId || turn.sessionId !== scope.sessionId)
					return false;
				const response = await this.room.fetch(
					new Request(`https://chat.internal/turn/${action}`, {
						method: "POST",
						body: JSON.stringify(turn),
					}),
				);
				if (response.status === 409) return false;
				if (response.status !== 204)
					throw new Error("Local turn coordination failed.");
				return true;
			},
			() =>
				this.withLocalPublisher(scope, () =>
					withCodexSubscriptionEgress(
						(input, options) => this.env.CODEX_EGRESS.fetch(input, options),
						() =>
							withClaudeRunnerPlacement(
								(candidate) =>
									new ClaudeRunnerPlacement(this.ctx.storage.sql).assign(
										candidate,
									),
								() => withEdgeModelEndpoints(run),
							),
					),
				),
		);
	}
	/**
	 * Admits a claimed turn; this chat's alarms then run its steps one at a time.
	 * Idempotent for the same turn. A turn admitted while another is active here
	 * waits and starts when that one ends.
	 */
	async startTurn(
		scope: { userId: string; sessionId: string },
		turn: WorkflowTurn,
		/** Set by budget admission (budget-admission.ts): the user is near their monthly compute budget. */
		options?: { degraded?: boolean },
	) {
		if (!this.bindIdentity(scope)) return false;
		if (options?.degraded) {
			try {
				this.ctx.storage.sql.exec(
					"create table if not exists budget_degraded(turn_id text primary key)",
				);
				this.ctx.storage.sql.exec(
					"insert or ignore into budget_degraded values(?)",
					turn.turnId,
				);
			} catch (error) {
				console.warn("Degraded turn was not marked.", {
					cause: stepFailureCause(error),
				});
			}
		}
		// The caller's scope carries no Y switch: read it once per turn start.
		if (!("yEnabled" in scope)) await this.resolveCrewScope(scope);
		const active = this.activeTurn();
		if (active?.turnId === turn.turnId) return active.leaseId === turn.leaseId;
		if (active) {
			const queued = this.queue.add({ ...scope, ...turn });
			// Only steps keep a waiting turn's lease fresh: a parked turn steps now.
			if (queued) await this.wakeSleepingTurn();
			return queued;
		}
		await this.beginTurn({ ...scope, ...turn });
		return true;
	}
	private async beginTurn(turn: QueuedTurn) {
		this.ctx.storage.sql.exec(
			"insert into turn_loop values(1,?,?,?,?,?,1,0)",
			turn.userId,
			turn.sessionId,
			turn.turnId,
			turn.leaseId,
			turn.leaseId,
		);
		this.noteTurnStatus(turn, "running");
		await this.wake("turn", Date.now());
	}
	/**
	 * Tells the user's hub (their open tabs) this chat's turn status. Fire and
	 * forget: the turn never waits on it, and a failure is only logged.
	 */
	private noteTurnStatus(
		scope: { userId: string; sessionId: string },
		turnStatus: SessionTurnStatus,
		items?: readonly SessionItem[],
	) {
		this.noteCrew(scope, turnStatus, items);
		if (!userHubEnabledFor(process.env.YTIMESY_USER_HUB_USERS, scope.userId))
			return;
		const warn = (error: unknown) =>
			console.warn("User hub was not told the turn status.", {
				turnStatus,
				cause: stepFailureCause(error),
			});
		try {
			this.ctx.waitUntil(
				this.env.USER_HUBS.getByName(scope.userId, durableObjectLocation())
					.noteTurn({ sessionId: scope.sessionId, turnStatus, at: Date.now() })
					.catch(warn),
			);
		} catch (error) {
			warn(error);
		}
	}
	/**
	 * Tells the project's crew (YSquaredCrew) this thread's state: one note
	 * when the turn starts and one when it settles, only for a Y project and
	 * never from Y² itself. Built from the transcript this object already
	 * holds, never from Postgres. Fire and forget, like the hub's note.
	 */
	private noteCrew(
		scope: { userId: string; sessionId: string },
		turnStatus: SessionTurnStatus,
		/** The turn's items when it ran elsewhere (a box); else this object's copy. */
		fromBox?: readonly SessionItem[],
	) {
		try {
			const crew = this.crewScope();
			const projectId = crewProjectFor(crew, scope.sessionId);
			if (!crew || !projectId) {
				console.log(
					`crew.note ${JSON.stringify({
						session: scope.sessionId.slice(0, 8),
						status: turnStatus,
						skipped: !crew
							? "no-scope"
							: !crew.yEnabled || !crew.projectId
								? "not-y"
								: "is-y2",
					})}`,
				);
				return;
			}
			let items: SessionItem[] = fromBox ? [...fromBox] : [];
			if (!fromBox)
				try {
					items = this.history.chatCopy()?.items ?? [];
				} catch {}
			// Every note names the thread (the start note too) and carries the
			// request the turn began with (no extra request).
			const derived = crewNoteFromItems(items, turnStatus, this.chatTitle);
			console.log(
				`crew.note ${JSON.stringify({
					session: scope.sessionId.slice(0, 8),
					status: turnStatus,
					state: derived.state,
					skipped: null,
					hasY2: !!crew.ySquaredId,
				})}`,
			);
			const note = {
				...derived,
				sessionId: scope.sessionId,
				userId: scope.userId,
				projectId,
				ySquaredId: crew.ySquaredId,
			};
			const send = () =>
				this.env.Y_SQUARED_CREWS.getByName(
					projectId,
					durableObjectLocation(),
				).noteThread(note);
			// A turn end is what Y² wakes for: one more try if the note's request
			// to the crew failed, so a blip does not lose it.
			this.ctx.waitUntil(
				send().catch(async (error: unknown) => {
					console.warn("Crew was not told the thread's state; trying again.", {
						cause: stepFailureCause(error),
					});
					await new Promise((resolve) => setTimeout(resolve, 1000));
					await send().catch((again: unknown) =>
						console.warn("Crew was not told the thread's state.", {
							cause: stepFailureCause(again),
						}),
					);
				}),
			);
		} catch (error) {
			console.warn("Crew was not told the thread's state.", {
				cause: stepFailureCause(error),
			});
		}
	}
	private activeTurn() {
		return this.ctx.storage.sql
			.exec<ActiveTurn>(
				`select user_id as userId,session_id as sessionId,turn_id as turnId,
				 lease_id as leaseId,current_lease_id as currentLeaseId,
				 step_index as stepIndex,resumes from turn_loop`,
			)
			.toArray()[0];
	}
	/**
	 * A request from the turn's Claude Code run (a tool call, a tool list)
	 * while its turn sleeps between steps: the next step runs now, so the
	 * call is answered without waiting out the pause.
	 */
	private async wakeSleepingTurn() {
		this.unpark();
		if (this.stepping || !this.activeTurn()) return;
		const at = this.ctx.storage.sql
			.exec<{ at: number }>(
				"select at from conversation_wake where purpose='turn'",
			)
			.toArray()[0]?.at;
		if (at !== undefined && at > Date.now())
			await this.wake("turn", Date.now());
	}
	/**
	 * The turn loop and the room's lease expiry share this object's single
	 * alarm. A turn wake set with `parkedTurn` is that Claude Code turn's
	 * parked renewal (claude-parked-turn.ts); any other turn wake unparks it,
	 * so the wake runs a step. A `thinking` wake checks a parked turn's VM
	 * once its quiet has lasted the grace (parkedVmPauseAt).
	 */
	private async wake(
		purpose: "turn" | "room" | "thinking",
		at: number | null,
		parkedTurn?: string,
	) {
		if (this.purged) return;
		if (purpose === "turn") {
			if (parkedTurn !== undefined && at !== null)
				this.ctx.storage.sql.exec(
					"insert into claude_park(id,turn_id) values(1,?) on conflict(id) do update set turn_id=excluded.turn_id",
					parkedTurn,
				);
			else this.unpark();
		}
		if (at === null)
			this.ctx.storage.sql.exec(
				"delete from conversation_wake where purpose=?",
				purpose,
			);
		else
			this.ctx.storage.sql.exec(
				"insert into conversation_wake values(?,?) on conflict(purpose) do update set at=excluded.at",
				purpose,
				at,
			);
		const next = this.ctx.storage.sql
			.exec<{ at: number | null }>(
				"select min(at) as at from conversation_wake",
			)
			.toArray()[0]?.at;
		if (next == null) await this.ctx.storage.deleteAlarm();
		else await this.ctx.storage.setAlarm(next);
	}
	/**
	 * Deletes everything this chat stored here (step receipts, history cache,
	 * queue, turn loop, room snapshot) and its alarm, when the chat, its
	 * project or its account is deleted. A second purge finds nothing left.
	 */
	private async purge(scope: { userId: string; sessionId: string }) {
		if (this.purged) return new Response(null, { status: 204 });
		const existing = this.ctx.storage.sql
			.exec<{ name: string }>("select name from conversation_identity")
			.toArray()[0]?.name;
		if (existing && existing !== modelConversationName(scope))
			return new Response(null, { status: 403 });
		this.purged = true;
		this.history.clear();
		await this.ctx.storage.deleteAlarm();
		// Deletes everything, then keeps the room's tombstone.
		await this.room.purge();
		this.ctx.storage.sql.exec(PURGE_TOMBSTONE_TABLE);
		this.ctx.storage.sql.exec(
			"insert or ignore into conversation_tombstone(id,purged_at) values(1,?)",
			Date.now(),
		);
		return new Response(null, { status: 204 });
	}
	/**
	 * A deploy or crash that resets this object mid-step makes Cloudflare re-run
	 * the alarm; the step's receipt is still "processing", so it is resumed.
	 */
	async alarm() {
		if (this.purged) {
			await this.ctx.storage.deleteAlarm();
			return;
		}
		const now = Date.now();
		const rows = this.ctx.storage.sql
			.exec<{ purpose: string; at: number }>(
				"select purpose,at from conversation_wake where at<=?",
				now,
			)
			.toArray();
		const due = new Set(rows.map((row) => row.purpose));
		if (due.has("room")) {
			await this.wake("room", null);
			await this.usage.timeStep(() => this.room.alarm(), 0);
		}
		if (due.has("thinking")) {
			await this.wake("thinking", null);
			this.pauseParkedVm(this.stepping);
		}
		const turnAt = rows.find((row) => row.purpose === "turn")?.at;
		// The turn's wake stays due while its step runs, so the room's lease
		// writes during the step re-arm the alarm at once; that alarm can fire
		// before the step ended and would resume it (rotating its lease) as if
		// the object had restarted. The running step schedules the next one
		// itself. After a real restart nothing runs here and the step resumes.
		if (turnAt === undefined || this.stepping) return;
		this.stepping = true;
		try {
			if (await this.usage.timeStep(() => this.renewParkedTurn())) return;
			await this.usage.timeStep(() => this.advanceTurn(now - turnAt));
		} finally {
			this.stepping = false;
			this.ctx.waitUntil(this.rollupUsage());
		}
	}
	/** The Claude Code turn parked here, if any (its next turn wake only renews). */
	private parkedTurnId() {
		return (
			this.ctx.storage.sql
				.exec<{ turnId: string }>("select turn_id as turnId from claude_park")
				.toArray()[0]?.turnId ?? null
		);
	}
	/**
	 * Something needs the parked turn's step (feed lines, an MCP call, Stop,
	 * a turn queued behind it): its next wake, even one already due, runs a
	 * step; a renewal in progress does not sleep again.
	 */
	private unpark() {
		if (this.renewingParked) this.parkInterrupted = true;
		if (this.purged) return;
		try {
			this.ctx.storage.sql.exec("delete from claude_park");
		} catch (error) {
			console.warn("Parked turn was not unparked.", {
				cause: stepFailureCause(error),
			});
		}
	}
	/** A parked turn's renewal is running (it awaits Postgres and the room). */
	private renewingParked = false;
	/** Something unparked the turn while its renewal ran. */
	private parkInterrupted = false;
	/**
	 * A parked Claude Code turn's wake (claude-parked-turn.ts): renews its
	 * Postgres lease (one statement) and its room lease (this object's own
	 * storage) and sleeps again, without a step's claim, workspace or
	 * metadata. False, and a step runs, when anything needs one, a renewal
	 * is refused, or it fails.
	 */
	private async renewParkedTurn() {
		const active = this.activeTurn();
		const parkedTurn = this.parkedTurnId();
		if (!active || parkedTurn === null) return false;
		const lease = { turnId: active.turnId, leaseId: active.currentLeaseId };
		this.renewingParked = true;
		this.parkInterrupted = false;
		try {
			const decision = parkedTurnRenewal({
				parked: parkedTurn === active.turnId,
				now: Date.now(),
				feed: this.heardFeedState(active.turnId),
				pendingCalls: pendingClaudeCodeCalls(active.turnId),
				waitingTurns: this.queue.waiting().length,
				room: await this.room.heldTurn(lease),
			});
			if (!decision.renew) {
				console.info(
					JSON.stringify({
						event: "claude.parked_step",
						turnId: active.turnId,
						reason: decision.reason,
					}),
				);
				return false;
			}
			const renewed = await withDatabaseScope(
				this.env.HYPERDRIVE.connectionString,
				() => renewParkedClaudeTurn(lease.turnId, lease.leaseId),
				null,
			);
			if (renewed !== "renewed") return false;
			if (!(await this.room.renewParked(lease, CLAUDE_PARKED_ROOM_LEASE_MS)))
				return false;
			if (this.parkInterrupted) return false;
			await this.wake(
				"turn",
				Date.now() + CLAUDE_PARKED_RENEW_MS,
				active.turnId,
			);
			console.info(
				JSON.stringify({ event: "claude.parked_renew", turnId: active.turnId }),
			);
			// A VM check the park's own refused (a background command, a
			// terminal) is tried again on this wake, without one of its own.
			this.pauseParkedVm(false);
			return true;
		} catch (error) {
			console.warn("Parked turn renewal failed; running a step.", {
				cause: stepFailureCause(error),
			});
			return false;
		} finally {
			this.renewingParked = false;
		}
	}
	/**
	 * Parks the turn whose step just asked to (claudeStepWake): its room
	 * lease first outlasts the sleep, or the room's own alarm would lapse it.
	 * False when the room no longer holds it uncancelled or the write fails.
	 */
	private async parkTurn(turnId: string) {
		const leaseId = this.activeTurn()?.currentLeaseId;
		if (!leaseId) return false;
		try {
			return await this.room.renewParked(
				{ turnId, leaseId },
				CLAUDE_PARKED_ROOM_LEASE_MS,
			);
		} catch (error) {
			console.warn("Claude turn was not parked.", {
				cause: stepFailureCause(error),
			});
			return false;
		}
	}
	/** A step of this object's turn is running in this instance. */
	private stepping = false;
	/** Bumped by every step: a VM check from before it is void. */
	private stepGeneration = 0;
	/**
	 * After a step: the turn's VM quiet as the step noted it, and whether
	 * its VM is still paused for thinking (a later instance of this object
	 * adopts that pause, so its next step resumes the VM first).
	 */
	private settleVmQuiet(turnId: string) {
		try {
			this.vmQuiet.write(
				nextParkedVmQuiet({
					turnId,
					previous: this.vmQuiet.read(),
					noted: takeClaudeTurnQuiet(turnId),
					pausedAt: pausedForThinkingAt,
				}),
			);
		} catch (error) {
			console.warn("Claude turn's VM quiet was not saved.", {
				cause: stepFailureCause(error),
			});
		}
	}
	/**
	 * A parked turn's VM may pause once its quiet lasted the grace: at once
	 * when it already has, else at one `thinking` wake (claude-parked-turn.ts).
	 */
	private async scheduleParkedVmPause(turnId: string) {
		if (!pauseVmWhileThinkingEnabled()) return;
		const now = Date.now();
		const at = parkedVmPauseAt({
			now,
			turnId,
			quiet: this.vmQuiet.read(),
			graceMs: THINKING_PAUSE_GRACE_MS,
		});
		if (at === null) return;
		if (at <= now) this.pauseParkedVm(false);
		else await this.wake("thinking", at);
	}
	/**
	 * Pauses the parked turn's VM if it is still quiet and its probes allow
	 * (thinking-pause.ts). Not awaited by the alarm: an MCP call arriving
	 * meanwhile wakes a step at once, and the step's guest operations wait
	 * for a pause in progress and resume the VM. Never throws.
	 */
	private pauseParkedVm(stepping: boolean) {
		if (!pauseVmWhileThinkingEnabled()) return;
		try {
			const quiet = this.vmQuiet.read();
			const decision = parkedVmPauseCheck({
				now: Date.now(),
				quiet,
				parkedTurn: this.parkedTurnId(),
				stepping,
				pendingCalls: quiet ? pendingClaudeCodeCalls(quiet.turnId) : 0,
				graceMs: THINKING_PAUSE_GRACE_MS,
			});
			if (!decision.check) return;
			const { turnId, userId } = decision.quiet;
			const vm = WorkspaceId(decision.quiet.vm);
			const generation = this.stepGeneration;
			const connection = this.env.HYPERDRIVE.connectionString;
			const current = () =>
				generation === this.stepGeneration &&
				this.parkedTurnId() === turnId &&
				pendingClaudeCodeCalls(turnId) === 0;
			const attempt = attemptThinkingPause({
				vm,
				machines: createFreestyleWorkspaceMachines(
					Effect.runSync(readFreestyleApiKey()),
				),
				otherTurnOnMachine: (target) =>
					withDatabaseScope(
						connection,
						() => otherRunningTurnOnMachine(userId, turnId, target),
						null,
					),
				toolsRunning: () => pendingClaudeCodeCalls(turnId),
				current,
				quietSince: decision.quiet.quietSince ?? Date.now(),
				trigger: "claude_parked",
			}).then((outcome) => {
				const pausedAt = pausedForThinkingAt(vm);
				if (outcome === "paused" && pausedAt !== null)
					this.vmQuiet.markPaused(turnId, pausedAt);
			});
			this.ctx.waitUntil(
				attempt.catch((error) =>
					console.warn("Parked turn's VM pause check failed.", {
						cause: stepFailureCause(error),
					}),
				),
			);
		} catch (error) {
			console.warn("Parked turn's VM pause check failed.", {
				cause: stepFailureCause(error),
			});
		}
	}
	/** Runs after the turn released its room lease, so a waiting turn can start. */
	private async endTurn(settled: SessionTurnStatus) {
		const ended = this.activeTurn();
		// The last turn's transcript stays, so the next turn reads only what
		// changed after it (seedFromChatCopy).
		try {
			this.history.keepChatCopy();
		} catch {
			this.history.clear();
		}
		if (ended) this.storeEndedHistory(ended);
		if (ended) this.endClaudeFeed(ended.turnId);
		if (ended) takeClaudeTurnQuiet(ended.turnId);
		this.vmQuiet.write(null);
		this.ctx.storage.sql.exec("delete from turn_loop");
		// A turn whose start found no crew scope still settles to its crew.
		if (ended && !this.crewScope()) await this.resolveCrewScope(ended);
		const next = this.queue.take();
		if (next) {
			await this.refreshWaiting([next]);
			// The crew still hears how the ended turn settled (reply, card, pull
			// request); the next turn's start note follows it.
			if (ended) this.noteCrew(ended, settled);
			await this.beginTurn(next);
		} else {
			if (ended) this.noteTurnStatus(ended, settled);
			await this.wake("turn", null);
		}
	}
	/**
	 * The ended turn's final model history, kept in private storage: the
	 * recovery point of the send that continues it refers to it
	 * (turnMessagesObject) instead of the send reading it. Best effort, after
	 * the turn: without it that point is restored from its transcript.
	 */
	private storeEndedHistory(ended: ActiveTurn) {
		let copy: ReturnType<TurnHistoryCache["chatMessagesCopy"]> = null;
		try {
			copy = this.history.chatMessagesCopy();
		} catch {
			return;
		}
		// Only a settled copy is the history Postgres keeps (and a send names).
		if (!copy || copy.turnId !== ended.turnId || !copy.settled) return;
		const { messages } = copy;
		this.ctx.waitUntil(
			storeTurnMessages({
				userId: ended.userId,
				sessionId: ended.sessionId,
				turnId: ended.turnId,
				messages,
			}).catch((error) =>
				console.warn("Turn history object was not stored.", {
					cause: stepFailureCause(error),
				}),
			),
		);
	}
	/** Keeps turns waiting behind the active one claimable; see refreshWaitingApiTurns. */
	private async refreshWaiting(turns = this.queue.waiting()) {
		if (!turns.length) return;
		await withDatabaseScope(
			this.env.HYPERDRIVE.connectionString,
			() => refreshWaitingApiTurns(turns),
			null,
		).catch(() => console.warn("Waiting turn refresh failed."));
	}
	/** Refreshes waiting turns now and while the active turn's step runs. */
	private keepWaitingTurnsFresh() {
		void this.refreshWaiting();
		const timer = setInterval(
			() => void this.refreshWaiting(),
			WAITING_TURN_REFRESH_MS,
		);
		return () => clearInterval(timer);
	}
	/**
	 * Stop on a turn still waiting here settles it now; the room never knew it,
	 * and leaving it queued kept the chat running until the old turn's loop ended.
	 */
	private async cancelWaiting(control: { turnId: string; leaseId: string }) {
		if (
			!this.queue
				.waiting()
				.some(
					(turn) =>
						turn.turnId === control.turnId && turn.leaseId === control.leaseId,
				)
		)
			return false;
		await withDatabaseScope(
			this.env.HYPERDRIVE.connectionString,
			() => cancelWaitingApiTurn(control.turnId, control.leaseId),
			null,
		);
		this.queue.remove(control.turnId, control.leaseId);
		return true;
	}
	/** Kind and start of the current run of failed attempts of one step (null: none, or this object restarted). */
	private stepFailureTransient: boolean | null = null;
	private stepFailuresSince: number | null = null;
	private async advanceTurn(alarmDelayMs = 0) {
		const active = this.activeTurn();
		if (!active) return this.wake("turn", null);
		return withStepTrace(
			{
				turn: active.turnId.slice(0, 8),
				index: active.stepIndex,
				resumes: active.resumes,
				alarmDelayMs,
			},
			() => this.advanceActiveTurn(),
		);
	}
	private async advanceActiveTurn() {
		const active = this.activeTurn();
		if (!active) return this.wake("turn", null);
		const step = {
			turnId: active.turnId,
			leaseId: active.leaseId,
			index: active.stepIndex,
		};
		// Infrastructure trouble (the coordinator, the edge, a cut connection) is
		// waited out with backoff for a long window, never failed; only a step
		// that keeps failing for another reason is abandoned (turn-interruption.ts).
		// A restart of this object forgets the kind: it then gets the long window
		// too (a platform reset is not the turn's fault).
		const transientFailing = this.stepFailureTransient !== false;
		if (
			!shouldRetryStep({
				transient: transientFailing,
				failures: active.resumes + 1,
				firstFailureAt: this.stepFailuresSince ?? Date.now(),
				now: Date.now(),
			})
		) {
			// Stop driving it and fail it now, so the chat is free and the user is
			// told why. If that write fails, lease expiry still marks it failed.
			console.warn("Chat step kept failing; turn abandoned.", {
				index: step.index,
			});
			await withDatabaseScope(
				this.env.HYPERDRIVE.connectionString,
				() => abandonApiTurn(step.turnId, step.leaseId),
				null,
			).catch(() => console.warn("Abandoned turn could not be failed now."));
			return this.endTurn("failed");
		}
		// A step runs: nothing of an earlier park holds.
		this.unpark();
		this.stepGeneration += 1;
		// A VM paused while the turn was parked, maybe by an earlier instance
		// of this object: the step's guest operations resume it first.
		const quiet = this.vmQuiet.read();
		if (quiet?.turnId === step.turnId && quiet.pausedAt !== null)
			adoptThinkingPause(WorkspaceId(quiet.vm), quiet.pausedAt);
		const resume = this.steps.read(step)?.state === "processing";
		// Counts consecutive attempts that did not finish this step.
		this.ctx.storage.sql.exec("update turn_loop set resumes=resumes+1");
		if (executorSecrets.parse(this.env).MODEL_EXECUTION_ENABLED !== "1")
			return this.endTurn("idle");
		let outcome: Awaited<ReturnType<typeof executeModelStep>>;
		const stopRefreshing = this.keepWaitingTurnsFresh();
		const feed = claudeFeedEnabled()
			? this.claudeFeedHook(step.turnId)
			: undefined;
		this.feedPending = null;
		const unregister = registerClaudeTurn(step.turnId, {
			watched: () => this.room.watched(),
			...(feed ? { feed: feed.feed } : {}),
		});
		try {
			outcome = await withDatabaseScope(
				this.env.HYPERDRIVE.connectionString,
				() =>
					this.withLocalConversation(active, () =>
						withBackgroundJobDispatcher(
							async (job) => {
								await startBackgroundJob(this.env, job);
							},
							() =>
								withConversationProgressWake(
									() => relayConversationDeliveriesOnce(active.sessionId),
									() =>
										withTurnHistoryMirror(
											// Everything the write reports, the transcript's revision
											// included: dropped, the next turn cannot start from this copy.
											(...written) => this.mirrorHistory(...written),
											() =>
												executeModelStep(
													step,
													() =>
														createFreestyleWorkspaceMachines(
															Effect.runSync(readFreestyleApiKey()),
														),
													{
														claim: (claimed, resumed) =>
															timed("step:claim", () =>
																this.claim(claimed, resumed),
															),
														complete: async (finished, result) => {
															if (!this.steps.finish(finished, result))
																throw new Error(
																	"Conversation receipt was not saved.",
																);
														},
													},
													AbortSignal.timeout(STEP_BUDGET_MS),
													resume,
													STEP_BUDGET_MS,
												),
										),
								),
						),
					),
				null,
			);
		} catch (error) {
			// Unknown outcome: a started step keeps its receipt and is resumed next time.
			// The cause is logged (redacted, bounded): without it a step that fails
			// at once, three times over, abandons the turn with nothing to diagnose.
			console.warn("Chat step failed; retrying.", {
				index: step.index,
				cause: stepFailureCause(error),
			});
			const transient =
				isTransientInfrastructureFailure(error) ||
				isCutConnection(error) ||
				isPlatformRestart(error) ||
				isEdgeOutage(error);
			this.stepFailureTransient = transient;
			this.stepFailuresSince ??= Date.now();
			return this.wake(
				"turn",
				Date.now() +
					(transient
						? stepRetryDelayMs(active.resumes + 1)
						: 5_000 * (active.resumes + 1)),
			);
		} finally {
			stopRefreshing();
			unregister();
			this.settleVmQuiet(step.turnId);
		}
		this.stepFailureTransient = null;
		this.stepFailuresSince = null;
		// The step's checkpoint is saved: so is where it read the run's feed.
		feed?.commit();
		// The lines that arrived during the step were read: the next batch's
		// wait counts from its own arrival, not theirs.
		if (feed && !feed.unread()) this.feedPending = null;
		if (outcome === "continue") {
			this.ctx.storage.sql.exec(
				"update turn_loop set step_index=step_index+1,resumes=0",
			);
			// A Claude Code step that paused sleeps before the next; a feed step
			// with nothing to do parks (only its leases are renewed until the
			// feed or a call wakes it); a call already waiting does not sleep.
			// Lines that arrived after the step's last read wake the next sooner.
			// While watched, at once: they came in while the step ran, so the
			// object did not preview them.
			const now = Date.now();
			const next = claudeStepWake({
				now,
				pause: takeClaudeStepPause(step.turnId),
				pendingCalls: pendingClaudeCodeCalls(step.turnId),
				waitingTurns: this.queue.waiting().length,
				unread: feed?.unread()
					? {
							urgent:
								this.feedMode() === "live" ||
								(this.pendingFeed()?.urgent ?? true),
							mode: this.feedMode(),
							pendingSince: this.pendingFeed()?.since ?? now,
						}
					: null,
				// A degraded turn (monthly budget nearly used) waits longer between steps.
				fallbackPauseMs:
					CLAUDE_STEP_PAUSE_MS * (this.turnDegraded(step.turnId) ? 2 : 1),
			});
			if (!next.parked) return this.wake("turn", next.at);
			if (await this.parkTurn(step.turnId)) {
				await this.wake("turn", next.at, step.turnId);
				return this.scheduleParkedVmPause(step.turnId);
			}
			return this.wake("turn", Date.now());
		}
		await this.endTurn(settledHubTurnStatus(outcome));
		if (
			outcome !== "unavailable" &&
			process.env.BACKGROUND_EXECUTION_ENABLED === "1"
		)
			await startBackgroundJob(this.env, {
				id: backgroundJobId(`completed:${step.turnId}:${step.leaseId}`),
				kind: "model-admission",
			});
	}
	private cachedModelHistory() {
		try {
			return this.history.chatMessagesCopy();
		} catch {
			return null;
		}
	}

	private cachedTurnHistory(
		turnId: string,
		version: string,
		from: string | null,
	) {
		try {
			return from
				? this.history.readActive(turnId, version, from)
				: this.history.read(turnId, version);
		} catch (error) {
			console.warn(
				"Turn history cache could not be read; loading stored history.",
				{ cause: stepFailureCause(error) },
			);
			return null;
		}
	}
	/**
	 * A turn row still holding the whole transcript (a box's turn handed here)
	 * moves to the chat-items shape first, so this step loads, writes and
	 * mirrors only the turn's own items, not the chat's megabytes
	 * (keepTurnItemsInChat). Best effort: when it cannot, the step runs on
	 * the whole array as before.
	 */
	private async keepItemsInChat(
		row: { id: string; items_from: string | null; version: string },
		leaseId: string,
	) {
		try {
			const kept = await keepTurnItemsInChat(row.id, leaseId);
			console.info(
				JSON.stringify({
					event: "turn.items_kept_in_chat",
					turnId: row.id,
					kept: kept !== null,
				}),
			);
			if (!kept) return;
			row.items_from = kept.from;
			row.version = kept.version;
		} catch (error) {
			console.warn("Turn items stay whole on the turn row this step.", {
				cause: stepFailureCause(error),
			});
		}
	}
	/**
	 * Runs after Postgres committed the write: a local storage failure must not
	 * fail the step, it only costs the next step a read from Postgres.
	 */
	private mirrorHistory(...args: Parameters<TurnHistoryCache["write"]>): void {
		try {
			this.history.write(...args);
		} catch (error) {
			console.warn("Turn history copy could not be saved here.", {
				cause: stepFailureCause(error),
			});
			try {
				this.history.clear(args[0]);
			} catch {
				// Its stored version predates this committed write, so it never matches again.
			}
		}
	}
	private async claim(
		step: WorkflowStep,
		resume = false,
	): Promise<WorkflowStepClaim> {
		const receipt = this.steps.read(step);
		if (receipt?.state === "done" && receipt.outcome)
			return { kind: "done", outcome: receipt.outcome };
		if (receipt && !resume) return { kind: "unavailable" };
		const active = this.activeTurn();
		let leaseId =
			active?.turnId === step.turnId && active.leaseId === step.leaseId
				? active.currentLeaseId
				: step.leaseId;
		if (receipt) {
			// A reset can leave the previous attempt running as a zombie that still
			// reaches Postgres. Rotating the lease rejects its writes and stops it.
			const rotated = crypto.randomUUID();
			const renewed = await database().query(
				`update api_turn set lease_id=$3,heartbeat_at=now() where id=$1 and lease_id=$2
				 and state='running' and executor='durable-object'`,
				[step.turnId, leaseId, rotated],
			);
			if (!renewed.rowCount) return { kind: "unavailable" };
			leaseId = rotated;
			this.ctx.storage.sql.exec(
				"update turn_loop set current_lease_id=?",
				rotated,
			);
			if (!(await this.room.reclaim({ turnId: step.turnId, leaseId })))
				return { kind: "unavailable" };
		}
		// The history (messages, items) is the bulk of a turn row; it comes from
		// this chat's copy unless another writer changed the turn since.
		const row = (
			await database().query<
				Omit<ApiTurn, "messages" | "items" | "items_from"> & {
					items_from: string | null;
					items_whole?: boolean;
					fresh: boolean;
					cancel_requested: boolean;
					past_deadline?: boolean;
					legacy: boolean;
					version: string;
				}
			>(
				`select t.id,t.session_id,t.user_id,t.connection_id,t.connection_revision,t.model_id,t.settings,t.failover,
			 t.state,t.lease_id,t.cancel_requested,t.updated_at::text as version,t.items->>'from' as items_from,
			 jsonb_typeof(t.items)='array' as items_whole,
			 (extract(epoch from t.created_at)*1000)::float8 as queued_at_ms,
			 ${apiTurnLeaseFreshSql("t")} as fresh,
			 ${turnPastDeadlineSql("t")} as past_deadline,
			 exists(select 1 from model_workflow_step s where s.turn_id=t.id) as legacy
			 from api_turn t where t.id=$1 and t.lease_id=$2 and t.executor='durable-object'`,
				[step.turnId, leaseId],
			)
		).rows[0];
		if (!row || row.legacy) return { kind: "unavailable" };
		// Only this chat's own turn runs here, however it was handed in.
		if (
			active &&
			(row.session_id !== active.sessionId || row.user_id !== active.userId)
		)
			return { kind: "unavailable" };
		if (
			row.state === "completed" ||
			row.state === "failed" ||
			row.state === "cancelled"
		)
			return { kind: "done", outcome: row.state };
		if (row.state !== "running" || !row.fresh) return { kind: "unavailable" };
		// An eval runner's hard deadline passed between steps: stop as if asked.
		if (row.past_deadline && !row.cancel_requested) {
			await database().query(
				"update api_turn set cancel_requested=true where id=$1 and lease_id=$2 and state='running'",
				[row.id, leaseId],
			);
			row.cancel_requested = true;
		}
		if (row.items_from === null && row.items_whole)
			await this.keepItemsInChat(row, leaseId);
		let history = this.cachedTurnHistory(row.id, row.version, row.items_from);
		const loadedFromDatabase = !history;
		if (!history) {
			const loaded = row.items_from
				? await activeTurnHistory(
						row.id,
						leaseId,
						row.items_from,
						this.cachedModelHistory(),
					)
				: (
						await database().query<
							Pick<ApiTurn, "messages" | "items"> & { items_rev: string }
						>(
							// A turn row in the new shape keeps no items; the chat's are the history.
							`select t.messages,case when jsonb_typeof(t.items)='array' then t.items else s.items end as items,
						 s.items_rev::text as items_rev
						 from api_turn t join agent_session s on s.id=t.session_id where t.id=$1 and t.lease_id=$2`,
							[row.id, leaseId],
						)
					).rows[0];
			if (!loaded) return { kind: "unavailable" };
			const { items_rev: itemsRev, ...whole } = loaded;
			history = whole;
			this.mirrorHistory(row.id, row.version, whole, undefined, itemsRev);
		}
		logTurnStepSizes(
			row.id,
			history,
			loadedFromDatabase ? "database" : "cache",
		);
		const { items_from: itemsFrom, items_whole: _whole, ...identity } = row;
		const turn = {
			...identity,
			...history,
			...(itemsFrom === null ? {} : { items_from: itemsFrom }),
		};
		if (turn.cancel_requested) return { kind: "cancelled", turn };
		// No await between reading and inserting: concurrent requests cannot claim the same step.
		const claimed = claimConversationStep(this.steps, step, Date.now(), resume);
		return claimed.kind === "claimed" ? { ...claimed, turn } : claimed;
	}
	/**
	 * The step's view of its run's feed. Where it read to is kept only once
	 * the step's checkpoint commits (`commit`), so an interrupted step's
	 * successor reads the same lines again.
	 */
	private claudeFeedHook(turnId: string) {
		let consumed: { run: number; to: number } | null = null;
		const feed: ClaudeCodeFeed = {
			state: (run) => this.heard(turnId, this.claudeFeed.state(turnId, run)),
			lines: (run, from, limit) =>
				this.claudeFeed.lines(turnId, run, from, limit),
			consume: (run, to) => {
				consumed = { run, to };
			},
			wait: (ms) =>
				new Promise<void>((resolve) => {
					const done = () => {
						clearTimeout(timer);
						this.feedWaiters.delete(done);
						resolve();
					};
					const timer = setTimeout(done, ms);
					this.feedWaiters.add(done);
				}),
		};
		return {
			feed,
			commit: () => {
				if (!consumed) return;
				try {
					this.claudeFeed.commitConsumed(turnId, consumed.run, consumed.to);
				} catch (error) {
					// The next step reads those lines again; never fail the turn for it.
					console.warn("Claude feed position was not saved.", {
						cause: stepFailureCause(error),
					});
				}
			},
			/** The run has lines (or its exit) the step did not read. */
			unread: () => {
				if (!consumed) return false;
				const state = this.claudeFeed.state(turnId, consumed.run);
				return Boolean(
					state &&
						state.lastSeen > 0 &&
						(state.receivedTo > consumed.to || state.exitStatus !== null),
				);
			},
		};
	}
	/** A run's feed record, `lastSeen` as the runner was last heard (its pings too). */
	private heard(turnId: string, state: ClaudeFeedState | null) {
		if (!state || state.lastSeen === 0) return state;
		return {
			...state,
			lastSeen: feedLastHeard(
				state.lastSeen,
				this.feedPongAt(turnId, state.run),
			),
		};
	}
	/** The turn's current run's feed, as last heard; null without one. */
	private heardFeedState(turnId: string) {
		return this.heard(turnId, this.claudeFeed.currentState(turnId));
	}
	/**
	 * When the runtime last answered a ping on one of the run's feed sockets
	 * (it does so without waking this object), null if never.
	 */
	private feedPongAt(turnId: string, run: number) {
		const ctx = this.ctx as unknown as {
			getWebSocketAutoResponseTimestamp?: (socket: WebSocket) => Date | null;
		};
		let latest: number | null = null;
		try {
			for (const socket of this.ctx.getWebSockets(turnId)) {
				if ((socket.deserializeAttachment() as FeedAttachment)?.run !== run)
					continue;
				const at = ctx.getWebSocketAutoResponseTimestamp?.(socket)?.getTime();
				if (at !== undefined && (latest === null || at > latest)) latest = at;
			}
		} catch {}
		return latest;
	}
	/**
	 * Brings the active turn's runners up to date (feedSyncFrames): the mode
	 * when someone started or stopped watching, the key of the sent messages
	 * waiting when it changed. Only runners that said they take inbox frames;
	 * outgoing frames are free.
	 */
	private syncClaudeFeeds() {
		const turnId = this.activeTurn()?.turnId;
		if (!turnId || !claudeFeedEnabled()) return;
		try {
			const now: FeedTold = {
				mode: this.feedMode(),
				inbox: claudeInboxKey(this.room.latestItems()),
			};
			for (const socket of this.ctx.getWebSockets(turnId)) {
				const attachment = socket.deserializeAttachment() as FeedAttachment;
				if (!attachment?.inbox || attachment.run === null) continue;
				const frames = feedSyncFrames(attachment.told ?? null, now);
				if (!frames.length) continue;
				for (const frame of frames) socket.send(JSON.stringify(frame));
				socket.serializeAttachment({
					...attachment,
					told: now,
				} satisfies FeedAttachment);
			}
		} catch (error) {
			// The runner's hooks then keep asking over HTTP as before.
			console.warn("Claude feed state was not sent.", {
				cause: stepFailureCause(error),
			});
		}
	}
	/** Lines that arrived since the step started (read through a call: a step changes it). */
	private pendingFeed() {
		return this.feedPending;
	}
	/** Live while someone has the chat open: the runner then batches every second. */
	private feedMode(): ClaudeFeedMode {
		return this.room.watched() ? "live" : "quiet";
	}
	/** The run's runner opens its feed: a hibernatable socket tagged with its turn. */
	private async acceptClaudeFeed(request: Request) {
		if (this.purged) return new Response(null, { status: 410 });
		const grant = await verifiedClaudeFeedGrant(
			request,
			this.env,
			(name) =>
				this.ctx.storage.sql
					.exec<{ name: string }>("select name from conversation_identity")
					.toArray()[0]?.name === name,
		);
		if (grant instanceof Response) return grant;
		const { client, server } = socketPair();
		this.ctx.acceptWebSocket(server as unknown as WebSocket, [
			CLAUDE_FEED_SOCKET_TAG,
			grant.turnId,
		]);
		server.serializeAttachment({
			turnId: grant.turnId,
			run: null,
		} satisfies FeedAttachment);
		const offered = (request.headers.get("sec-websocket-protocol") ?? "")
			.split(",")
			.some((value) => value.trim() === CLAUDE_FEED_PROTOCOL);
		return new Response(null, {
			status: 101,
			webSocket: client,
			headers: offered
				? { "sec-websocket-protocol": CLAUDE_FEED_PROTOCOL }
				: {},
		} as ResponseInit);
	}
	/** One message from a run's feed (claude-feed.ts); anything unexpected stops that feed. */
	private async claudeFeedMessage(
		socket: WebSocket,
		message: string | ArrayBuffer,
	) {
		const reply = (value: unknown) => {
			try {
				socket.send(JSON.stringify(value));
			} catch {}
		};
		const stop = () => {
			reply({ type: "stop" });
			try {
				socket.close(1000, "stop");
			} catch {}
		};
		// The runtime answers a ping without waking this object; should one
		// still reach it, it is answered the same and counts as heard.
		if (message === CLAUDE_FEED_PING && !this.purged && claudeFeedEnabled()) {
			try {
				socket.send(LIVE_SOCKET_PONG);
			} catch {}
			const { turnId, run } = socket.deserializeAttachment() as FeedAttachment;
			if (run !== null) this.claudeFeed.touch(turnId, run, Date.now());
			return;
		}
		if (
			this.purged ||
			!claudeFeedEnabled() ||
			typeof message !== "string" ||
			message.length > CLAUDE_FEED_MAX_MESSAGE
		)
			return stop();
		let value: unknown;
		try {
			value = JSON.parse(message);
		} catch {
			return stop();
		}
		const parsed = claudeFeedMessage.safeParse(value);
		if (!parsed.success) return stop();
		const attachment = socket.deserializeAttachment() as FeedAttachment;
		const turn = attachment.turnId;
		// Only the turn running here, and only its current run, is followed.
		if (this.activeTurn()?.turnId !== turn) return stop();
		const data = parsed.data;
		const now = Date.now();
		const mode = this.feedMode();
		if (data.type === "hello") {
			if (data.turnId !== turn || attachment.run !== null) return stop();
			const receivedTo = this.claudeFeed.hello(turn, data.run, now);
			if (receivedTo === null) return stop();
			socket.serializeAttachment({
				turnId: turn,
				run: data.run,
				inbox: data.inbox === true,
				told: null,
			} satisfies FeedAttachment);
			// `ping`: this object reads the runtime's answers to pings as heard.
			reply({ type: "ack", receivedTo, mode, ping: true });
			// A (re)connected runner learns the mode and what is waiting now.
			return this.syncClaudeFeeds();
		}
		const run = attachment.run;
		const state = run === null ? null : this.claudeFeed.state(turn, run);
		if (run === null || !state) return stop();
		if (data.type === "lines") {
			const decision = this.claudeFeed.accept(turn, run, data, now);
			if (!decision) return stop();
			if (decision.kind === "need")
				return reply({ type: "need", from: decision.from });
			reply({ type: "ack", receivedTo: decision.receivedTo, mode });
			if (decision.kind === "accept") {
				const urgent = data.entries.some(([, line]) => isUrgentFeedLine(line));
				// Watched with no step running: the object shows the text itself
				// and the step sleeps on; what it cannot show wakes the step now.
				const unshown =
					mode === "live" &&
					!urgent &&
					!this.stepping &&
					!this.previewClaudeFeed(turn, data.entries);
				await this.claudeFeedArrived(urgent || unshown, mode, now);
			}
			return;
		}
		if (data.type === "exit") {
			this.claudeFeed.exit(turn, run, String(data.status), now);
			reply({ type: "ack", receivedTo: state.receivedTo, mode });
			return this.claudeFeedArrived(true, mode, now);
		}
		this.claudeFeed.touch(turn, run, now);
		reply({ type: "ack", receivedTo: state.receivedTo, mode });
	}
	/**
	 * Previews a batch's text to the chat's live sockets, redacted with the
	 * turn's list as its last step left it (claude-feed-preview.ts). False
	 * when it could not be shown to every viewer: no list in this isolate (it
	 * restarted), a frame too large, or a viewer on the event stream. Never
	 * touches the chat's copy or its revision.
	 */
	private previewClaudeFeed(
		turnId: string,
		entries: readonly (readonly [number, string])[],
	) {
		const redact = claudeTurnRedaction(turnId);
		if (!redact) return false;
		try {
			const preview = claudeFeedPreview(turnId, entries, redact());
			if (!preview.events.length) return true;
			const frame = livePreviewFrame(preview);
			return frame !== null && this.room.preview(frame);
		} catch (error) {
			console.warn("Claude feed preview was not sent.", {
				cause: stepFailureCause(error),
			});
			return false;
		}
	}
	/**
	 * Lines (or the exit) arrived: a waiting step reads them now; a sleeping
	 * turn is woken at once for urgent ones, else at the mode's wake cadence.
	 */
	private async claudeFeedArrived(
		urgent: boolean,
		mode: ClaudeFeedMode,
		now: number,
	) {
		for (const done of [...this.feedWaiters]) done();
		// A parked turn's next wake reads them (a step, not a renewal).
		this.unpark();
		this.feedPending = {
			since: this.feedPending?.since ?? now,
			urgent: urgent || Boolean(this.feedPending?.urgent),
		};
		if (this.stepping) return;
		const scheduledAt =
			this.ctx.storage.sql
				.exec<{ at: number }>(
					"select at from conversation_wake where purpose='turn'",
				)
				.toArray()[0]?.at ?? null;
		const at = feedWakeAt({
			now,
			urgent: this.feedPending.urgent,
			mode,
			pendingSince: this.feedPending.since,
			scheduledAt,
		});
		if (scheduledAt === null || at < scheduledAt) await this.wake("turn", at);
	}
	/** The turn ended: its feed's lines go, and its runner stops sending. */
	private endClaudeFeed(turnId: string) {
		forgetClaudeTurn(turnId);
		try {
			this.claudeFeed.clearTurn(turnId);
			for (const socket of this.ctx.getWebSockets(turnId)) {
				try {
					socket.send(JSON.stringify({ type: "stop" }));
					socket.close(1000, "turn ended");
				} catch {}
			}
		} catch (error) {
			console.warn("Claude feed was not cleared.", {
				cause: stepFailureCause(error),
			});
		}
	}
	/** The turn runner box's one socket for a turn: hibernatable, tagged with the turn. */
	private async acceptTurnBoxSocket(request: Request) {
		if (this.purged) return new Response(null, { status: 410 });
		const grant = await verifiedTurnBoxSocketGrant(
			request,
			this.env,
			(name) =>
				this.ctx.storage.sql
					.exec<{ name: string }>("select name from conversation_identity")
					.toArray()[0]?.name === name,
		);
		if (grant instanceof Response) return grant;
		// A newer socket for the turn replaces the older one.
		for (const old of this.ctx.getWebSockets(grant.turnId))
			if (this.isTurnBoxSocket(old))
				try {
					old.close(1000, "replaced");
				} catch {}
		const { client, server } = socketPair();
		this.ctx.acceptWebSocket(server as unknown as WebSocket, [
			TURN_BOX_SOCKET_TAG,
			grant.turnId,
		]);
		server.serializeAttachment({
			userId: grant.userId,
			sessionId: grant.sessionId,
			turnId: grant.turnId,
			leaseId: grant.leaseId,
			boxId: grant.boxId,
		} satisfies TurnBoxSocketAttachment);
		// A reconnected box gets the Claude calls it has not taken yet.
		this.claudeRelay.deliver(grant.turnId, true);
		return new Response(null, {
			status: 101,
			webSocket: client,
		} as ResponseInit);
	}
	private async turnBoxSocketMessage(
		socket: WebSocket,
		message: string | ArrayBuffer,
	) {
		const attachment =
			socket.deserializeAttachment() as TurnBoxSocketAttachment | null;
		if (!attachment) return socket.close(1008, "unknown turn");
		// A Claude Code turn's relay messages need no database: they only pass
		// calls and answers between the box and the calls' edge requests.
		const relayed = this.claudeRelayBoxMessage(attachment.turnId, message);
		this.claudeRelay.deliver(attachment.turnId);
		if (relayed) return;
		const { reply, close } = await this.relayToViewers(attachment, () =>
			answerTurnBoxSocketMessage(
				attachment,
				message,
				createTurnBoxEdgeOps(
					turnBoxRequestScope(this.env.HYPERDRIVE.connectionString, (job) =>
						startBackgroundJob(this.env, job).then(() => undefined),
					),
				),
			),
		);
		for (const item of reply) socket.send(JSON.stringify(item));
		if (close) socket.close(1008, "refused");
	}
	/** A box's Claude relay message (true when it was one). */
	private claudeRelayBoxMessage(turnId: string, message: string | ArrayBuffer) {
		if (typeof message !== "string" || !message.startsWith('{"t":"claude-'))
			return false;
		const parsed = boxSocketMessage.safeParse(
			(() => {
				try {
					return JSON.parse(message);
				} catch {
					return null;
				}
			})(),
		);
		if (!parsed.success || !isClaudeRelayBoxMessage(parsed.data)) return false;
		const data = parsed.data;
		if (data.t === "claude-tools")
			this.claudeRelay.tools(turnId, data.definitions);
		else if (data.t === "claude-ack") this.claudeRelay.ack(data.ids);
		else if (data.t === "claude-reply")
			this.claudeRelay.reply(data.id, data.reply as McpCallResult, turnId);
		return true;
	}
	/** A relayed Claude Code call's edge request: one hibernatable socket per call. */
	private async acceptClaudeRelayCall(request: Request) {
		if (this.purged) return new Response(null, { status: 410 });
		const id = new URL(request.url).searchParams.get("id") ?? "";
		if (!/^[0-9a-f-]{36}$/.test(id)) return new Response(null, { status: 400 });
		const grant = await verifiedClaudeRelayGrant(request, this.env, (name) =>
			this.identityNameIs(name),
		);
		if (grant instanceof Response) return grant;
		const { client, server } = socketPair();
		this.ctx.acceptWebSocket(server as unknown as WebSocket, [
			CLAUDE_RELAY_CALL_TAG,
			claudeRelayCallTag(id),
		]);
		server.serializeAttachment({ turnId: grant.turnId, id });
		return new Response(null, {
			status: 101,
			webSocket: client,
		} as ResponseInit);
	}
	private identityNameIs(name: string) {
		return (
			this.ctx.storage.sql
				.exec<{ name: string }>("select name from conversation_identity")
				.toArray()[0]?.name === name
		);
	}
	private isClaudeRelayCall(socket: WebSocket) {
		try {
			return this.ctx.getTags(socket).includes(CLAUDE_RELAY_CALL_TAG);
		} catch {
			return false;
		}
	}
	private claudeRelayCallMessage(
		socket: WebSocket,
		message: string | ArrayBuffer,
	) {
		const attachment = socket.deserializeAttachment() as {
			turnId: string;
			id: string;
		} | null;
		if (!attachment || typeof message !== "string")
			return socket.close(1008, "refused");
		let parsed: ReturnType<typeof relayCallMessage.safeParse>;
		try {
			parsed = relayCallMessage.safeParse(JSON.parse(message));
		} catch {
			return socket.close(1008, "refused");
		}
		if (!parsed.success) return socket.close(1008, "refused");
		this.claudeRelay.call(attachment.turnId, attachment.id, parsed.data);
	}
	/**
	 * The tools a box published for its Claude Code turn (worker RPC, after
	 * the worker checked the run's grant for this chat).
	 */
	claudeRelayTools(turnId: string) {
		return this.claudeRelay.listedTools(turnId);
	}
	/** The chat's pinned Claude runner for a box's turn (worker RPC; claude-runner-placement.ts). */
	claudeRunnerPlacement(candidate: string) {
		return new ClaudeRunnerPlacement(this.ctx.storage.sql).assign(candidate);
	}
	private isTurnBoxSocket(socket: WebSocket) {
		try {
			return this.ctx.getTags(socket).includes(TURN_BOX_SOCKET_TAG);
		} catch {
			return false;
		}
	}
	private isClaudeFeed(socket: WebSocket) {
		try {
			return this.ctx.getTags(socket).includes(CLAUDE_FEED_SOCKET_TAG);
		} catch {
			return false;
		}
	}
	async fetch(request: Request) {
		this.usage.record({ requests: 1 });
		const path = new URL(request.url).pathname;
		if (path === CLAUDE_CODE_FEED_PATH) return this.acceptClaudeFeed(request);
		if (path === TURN_BOX_PATHS.socket)
			return this.acceptTurnBoxSocket(request);
		if (path === CLAUDE_RELAY_CALL_PATH)
			return this.acceptClaudeRelayCall(request);
		// The VM's Claude Code asking for ytimesy's tools; the turn's step runs them.
		if (path === CLAUDE_CODE_MCP_PATH) {
			if (this.purged) return new Response(null, { status: 410 });
			await this.wakeSleepingTurn();
			return answerClaudeCodeMcp(
				request,
				this.env,
				(name) =>
					this.ctx.storage.sql
						.exec<{ name: string }>("select name from conversation_identity")
						.toArray()[0]?.name === name,
			);
		}
		if (isRealtimeRoute(path)) {
			const secret = process.env.YTIMESY_REALTIME_SECRET;
			if (!secret || secret.length < 32)
				return new Response(null, { status: 503 });
			return routeRealtimeRequest(
				request,
				secret,
				async (scope, authenticated) => {
					if (path === "/purge") return this.purge(scope);
					if (this.purged) return new Response(null, { status: 410 });
					if (!this.bindIdentity(scope))
						return new Response(null, { status: 403 });
					if (path === "/turn/cancel") {
						const control = turnControlSchema.safeParse(
							await authenticated.clone().json(),
						);
						if (control.success && (await this.cancelWaiting(control.data)))
							return new Response(null, { status: 204 });
						const response = await this.room.fetch(authenticated);
						// The room holds the stop; the turn running here stops now, and
						// one sleeping between steps (parked or paused) wakes to stop.
						if (control.success && response.status === 204) {
							// A turn running on a box hears Stop over its socket.
							pushCancelToTurnBox(
								this.ctx
									.getWebSockets(control.data.turnId)
									.filter((open) => this.isTurnBoxSocket(open)),
							);
							abortLiveTurn(control.data.turnId);
							if (this.activeTurn()?.turnId === control.data.turnId)
								await this.wakeSleepingTurn();
						}
						return response;
					}
					const response = await this.room.fetch(authenticated);
					// A new viewer: the runner sends every second from now on.
					if (path === "/live" || path === "/stream") this.syncClaudeFeeds();
					return response;
				},
			);
		}
		const secrets = executorSecrets.parse(this.env);
		if (secrets.MODEL_EXECUTION_ENABLED !== "1")
			return new Response(null, { status: 503 });
		return withDatabaseScope(
			this.env.HYPERDRIVE.connectionString,
			() =>
				routeModelConversationStep(
					request,
					secrets.MODEL_WORKFLOW_SECRET,
					resolveModelConversation,
					async (scope, authenticated) => {
						if (this.purged) return new Response(null, { status: 410 });
						if (!this.bindIdentity(scope))
							return new Response(null, { status: 403 });
						return this.withLocalConversation(scope, () =>
							withBackgroundJobDispatcher(
								async (job) => {
									if (process.env.BACKGROUND_EXECUTION_ENABLED !== "1")
										throw new Error("Background execution is disabled.");
									await startBackgroundJob(this.env, job);
								},
								() =>
									withConversationProgressWake(
										() => relayConversationDeliveriesOnce(scope.sessionId),
										() =>
											executeWorkflowRequest(
												authenticated,
												secrets.MODEL_WORKFLOW_SECRET,
												() =>
													createFreestyleWorkspaceMachines(
														Effect.runSync(readFreestyleApiKey()),
													),
												{
													claim: (step) => this.claim(step),
													complete: async (step, outcome) => {
														if (!this.steps.finish(step, outcome))
															throw new Error(
																"Conversation receipt was not saved.",
															);
													},
												},
											),
									),
							),
						);
					},
				),
			null,
		);
	}

	// The room's live viewers and the Claude Code runs' feeds are this
	// object's hibernatable sockets, told apart by tag.
	async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
		this.usage.record({ wsMsgs: 1 });
		if (this.isTurnBoxSocket(socket))
			return this.turnBoxSocketMessage(socket, message);
		if (this.isClaudeRelayCall(socket))
			return this.claudeRelayCallMessage(socket, message);
		if (this.isClaudeFeed(socket))
			return this.claudeFeedMessage(socket, message);
		this.room.webSocketMessage(socket, message);
	}
	webSocketClose(
		socket: WebSocket,
		code: number,
		reason: string,
		wasClean: boolean,
	) {
		// A box reconnects with a fresh grant; the lease decides whether it still owns the turn.
		if (this.isTurnBoxSocket(socket)) {
			try {
				socket.close(code === 1005 || code === 1006 ? 1000 : code, reason);
			} catch {}
			return;
		}
		// A relayed call's edge request ended: a call not yet taken is dropped.
		if (this.isClaudeRelayCall(socket)) {
			const attachment = socket.deserializeAttachment() as {
				id?: string;
			} | null;
			if (attachment?.id) this.claudeRelay.callClosed(attachment.id);
			try {
				socket.close(code === 1005 || code === 1006 ? 1000 : code, reason);
			} catch {}
			return;
		}
		// A feed's runner reconnects on its own; the feed's state stays.
		if (this.isClaudeFeed(socket)) {
			try {
				socket.close(code === 1005 || code === 1006 ? 1000 : code, reason);
			} catch {}
			return;
		}
		this.room.webSocketClose(socket, code, reason, wasClean);
		this.syncClaudeFeeds();
	}
	webSocketError(socket: WebSocket, error: unknown) {
		if (
			this.isClaudeFeed(socket) ||
			this.isTurnBoxSocket(socket) ||
			this.isClaudeRelayCall(socket)
		)
			return;
		this.room.webSocketError(socket, error);
	}

	constructor(ctx: DurableObjectState, env: EdgeExecutorEnvironment) {
		super(ctx, env);
		registerMemoryRepos(env.ARTIFACTS);
		registerMemoryEmbeddings(env.AI);
		registerUserHubNotes(env);
		this.room = new ConversationRoom(ctx, (at: number | null) =>
			this.wake("room", at),
		);
		this.steps = new SqliteConversationSteps(ctx.storage.sql);
		this.claudeFeed = new SqliteClaudeFeed(ctx.storage.sql);
		this.claudeRelay = new ClaudeRelay(ctx.storage.sql, {
			box: (turnId) =>
				ctx
					.getWebSockets(turnId)
					.filter((socket) => this.isTurnBoxSocket(socket)),
			call: (id) => ctx.getWebSockets(claudeRelayCallTag(id)),
		});
		this.vmQuiet = new SqliteClaudeVmQuiet(ctx.storage.sql);
		// A newer snapshot may list a sent message (or no longer): the runner hears it.
		this.room.onAdopted(() => this.syncClaudeFeeds());
		this.history = new TurnHistoryCache(ctx.storage.sql);
		this.queue = new SqliteTurnQueue(ctx.storage.sql);
		this.usage = new UsageMeter(ctx.storage.sql, () => this.meterUserId());
		ctx.storage.sql.exec(
			"create table if not exists conversation_identity(id integer primary key check(id=1),name text not null)",
		);
		ctx.storage.sql.exec(`create table if not exists turn_loop(
			id integer primary key check(id=1), user_id text not null, session_id text not null,
			turn_id text not null, lease_id text not null, current_lease_id text not null,
			step_index integer not null, resumes integer not null)`);
		ctx.storage.sql.exec(
			"create table if not exists conversation_wake(purpose text primary key,at integer not null)",
		);
		// The Claude Code turn parked between steps (claude-parked-turn.ts).
		ctx.storage.sql.exec(
			"create table if not exists claude_park(id integer primary key check(id=1),turn_id text not null)",
		);
		ctx.storage.sql.exec(PURGE_TOMBSTONE_TABLE);
		this.purged =
			ctx.storage.sql
				.exec<{ n: number }>("select count(*) as n from conversation_tombstone")
				.toArray()[0]?.n > 0;
	}
}

/**
 * How often the scheduled jobs below run that are not every minute, by
 * action; keep in step with the schedule. A runtime blip is emailed only
 * when the job's next run fails the same way (alertCronFailure).
 */
const CRON_EVERY_MINUTES: Readonly<Record<string, number>> = {
	infrastructure: 5,
	"memory-dreams": 5,
	refresh: 60,
	"evidence-expiry": 360,
	"archive-expiry": 360,
};

const edgeExecutorWorker = {
	async scheduled(
		controller: ScheduledController,
		env: EdgeExecutorEnvironment,
	) {
		registerAuthEmailBinding(env.EMAIL);
		registerMemoryRepos(env.ARTIFACTS);
		registerMemoryEmbeddings(env.AI);
		registerUserHubNotes(env);
		const minute = Math.floor(controller.scheduledTime / 60_000);
		// Codex egress health: every 5 minutes, only when an account to probe
		// with is named. Alerts the owner when a path is blocked.
		const probeUser = process.env.YTIMESY_CODEX_EGRESS_PROBE_USER_ID;
		const probe =
			probeUser && minute % 5 === 0
				? withDatabaseScope(
						env.HYPERDRIVE.connectionString,
						() =>
							withCodexSubscriptionEgress(
								(input, options) => env.CODEX_EGRESS.fetch(input, options),
								() => probeCodexEgress(probeUser),
							),
						null,
					).then(
						(results) => console.info("Codex egress probe.", { results }),
						() => console.warn("Codex egress probe failed."),
					)
				: undefined;
		if (
			process.env.BACKGROUND_EXECUTION_ENABLED !== "1" ||
			process.env.YTIMESY_BACKGROUND_CRON_ENABLED !== "1"
		) {
			await probe;
			return;
		}
		const jobs = [
			backgroundJob.parse({
				id: backgroundJobId(`cron:${minute}:model-admission`),
				kind: "model-admission",
			}),
			...(["reconcile", "supervise", "delivery", "checkpoints"] as const).map(
				(action) =>
					backgroundJob.parse({
						id: backgroundJobId(`cron:${minute}:${action}`),
						kind: "maintenance",
						action,
					}),
			),
			...(["task-event", "pr-repair"] as const).map((kind) =>
				backgroundJob.parse({
					id: backgroundJobId(`cron:${minute}:${kind}`),
					kind,
					...(kind === "task-event" ? { eventId: null } : {}),
				}),
			),
		];
		if (minute % 5 === 0)
			jobs.push(
				backgroundJob.parse({
					id: backgroundJobId(`cron:${minute}:infrastructure`),
					kind: "maintenance",
					action: "infrastructure",
				}),
			);
		if (minute % 5 === 0)
			jobs.push(
				backgroundJob.parse({
					id: backgroundJobId(`cron:${minute}:memory-dreams`),
					kind: "maintenance",
					action: "memory-dreams",
				}),
			);
		if (minute % 360 === 30)
			jobs.push(
				backgroundJob.parse({
					id: backgroundJobId(`cron:${minute}:evidence-expiry`),
					kind: "maintenance",
					action: "evidence-expiry",
				}),
			);
		if (minute % 360 === 45)
			jobs.push(
				backgroundJob.parse({
					id: backgroundJobId(`cron:${minute}:archive-expiry`),
					kind: "maintenance",
					action: "archive-expiry",
				}),
			);
		if (minute % 60 === 0)
			jobs.push(
				backgroundJob.parse({
					id: backgroundJobId(`cron:${minute}:refresh`),
					kind: "maintenance",
					action: "refresh",
				}),
			);
		// Periodic jobs are short and the next tick retries them, so they run here
		// directly instead of each starting a durable instance every minute.
		const results = await Promise.allSettled(
			jobs
				.filter(
					(job) =>
						job.kind !== "model-admission" ||
						process.env.MODEL_EXECUTION_ENABLED === "1",
				)
				.map((job) => runBackgroundJob(env, job)),
		);
		const failures: Promise<unknown>[] = [];
		for (const [index, result] of results.entries())
			if (result.status === "rejected") {
				const action = "action" in jobs[index] ? jobs[index].action : undefined;
				const job = {
					kind: jobs[index].kind,
					action,
					everyMinutes: (action && CRON_EVERY_MINUTES[action]) || 1,
				};
				console.warn("Scheduled job failed.", job);
				// Error tracking and an owner email (at most hourly per job); a
				// single runtime blip (a deploy swapping versions) is not emailed.
				failures.push(
					withDatabaseScope(env.HYPERDRIVE.connectionString, () =>
						alertCronFailure(job, result.reason),
					).catch(() => undefined),
				);
			}
		await Promise.all([...failures, probe]);
	},
	async fetch(
		request: Request,
		env: EdgeExecutorEnvironment,
		ctx?: ExecutionContext,
	): Promise<Response> {
		registerAuthEmailBinding(env.EMAIL);
		registerMemoryRepos(env.ARTIFACTS);
		registerMemoryEmbeddings(env.AI);
		registerUserHubNotes(env);
		let stage = "ingress";
		try {
			const path = new URL(request.url).pathname;
			const route = executorIngressRoute(path);
			// Readiness for the production deploy's smoke check: this version
			// booted and answers. Public, no bindings touched.
			if (route === "health")
				return request.method === "GET"
					? Response.json(
							{ build: BUILD_ID },
							{ headers: { "Cache-Control": "no-store" } },
						)
					: new Response(null, { status: 405 });
			// By exact name: /turn/start below is not the room's.
			if (route === "room") {
				const secret = process.env.YTIMESY_REALTIME_SECRET;
				if (!secret || secret.length < 32)
					return new Response(null, { status: 503 });
				return routeRealtimeRequest(request, secret, (scope, authenticated) =>
					env.MODEL_CONVERSATIONS.getByName(
						modelConversationName(scope),
						durableObjectLocation(),
					).fetch(authenticated),
				);
			}
			// A signed-in tab's hub socket, after the web Worker checked the user.
			if (route === "user-hub") {
				const secret = process.env.YTIMESY_REALTIME_SECRET;
				if (!secret || secret.length < 32)
					return new Response(null, { status: 503 });
				if (request.method !== "GET")
					return new Response(null, { status: 404 });
				if (!(await verifyDeliveryRequest(secret, request, "")))
					return new Response(null, { status: 401 });
				const userId = new URL(request.url).searchParams.get("userId");
				if (!userId) return new Response(null, { status: 400 });
				// No signal: it would stay bound to the socket after the handshake.
				return env.USER_HUBS.getByName(userId, durableObjectLocation()).fetch(
					new Request(request.url, { headers: request.headers }),
				);
			}
			// The web Worker tells a user's hub what changed (noteUserHub).
			if (route === "user-note") {
				const secret = process.env.YTIMESY_REALTIME_SECRET;
				if (!secret || secret.length < 32)
					return new Response(null, { status: 503 });
				if (request.method !== "POST")
					return new Response(null, { status: 404 });
				let body: string;
				try {
					body = await readBoundedRequestBody(request, 4_000);
				} catch {
					return new Response(null, { status: 413 });
				}
				if (!(await verifyDeliveryRequest(secret, request, body)))
					return new Response(null, { status: 401 });
				let value: unknown;
				try {
					value = JSON.parse(body);
				} catch {
					return new Response(null, { status: 400 });
				}
				const note = parseHubNote(value);
				if (!note) return new Response(null, { status: 400 });
				if (!userHubEnabledFor(process.env.YTIMESY_USER_HUB_USERS, note.userId))
					return new Response(null, { status: 204 });
				await env.USER_HUBS.getByName(
					note.userId,
					durableObjectLocation(),
				).noteSignals(note.topics);
				return new Response(null, { status: 204 });
			}
			// The web Worker claimed a sent message's turn on its own database
			// connection (turn-start.ts) and hands it to the chat's loop here.
			if (route === "turn-start") {
				if (request.method !== "POST")
					return new Response(null, { status: 404 });
				const config = z
					.object({
						BACKGROUND_EXECUTION_ENABLED: z.literal("1"),
						BACKGROUND_WORKFLOW_SECRET: z.string().min(32),
					})
					.safeParse(env);
				if (!config.success || process.env.MODEL_EXECUTION_ENABLED !== "1")
					return new Response(null, { status: 503 });
				let body: string;
				try {
					body = await readBoundedRequestBody(request, 4_000);
				} catch {
					return new Response(null, { status: 413 });
				}
				if (
					!(await verifyDeliveryRequest(
						config.data.BACKGROUND_WORKFLOW_SECRET,
						request,
						body,
					))
				)
					return new Response(null, { status: 401 });
				let value: unknown;
				try {
					value = JSON.parse(body);
				} catch {
					return new Response(null, { status: 400 });
				}
				const turn = turnStartRequest.safeParse(value);
				if (!turn.success) return new Response(null, { status: 400 });
				const started = await startClaimedTurn(env, turn.data);
				if (started === "held" || started === "paused")
					return new Response(null, {
						status: 423,
						headers: { "x-budget-hold": started },
					});
				return new Response(null, { status: started ? 204 : 409 });
			}
			if (route === "jobs-start") {
				if (request.method !== "POST")
					return new Response(null, { status: 404 });
				const config = z
					.object({
						BACKGROUND_EXECUTION_ENABLED: z.literal("1"),
						BACKGROUND_WORKFLOW_SECRET: z.string().min(32),
					})
					.safeParse(env);
				if (!config.success) return new Response(null, { status: 503 });
				let body: string;
				try {
					body = await readBoundedRequestBody(request, 40_000);
				} catch {
					return new Response(null, { status: 413 });
				}
				if (
					!(await verifyDeliveryRequest(
						config.data.BACKGROUND_WORKFLOW_SECRET,
						request,
						body,
					))
				)
					return new Response(null, { status: 401 });
				let value: unknown;
				try {
					value = JSON.parse(body);
				} catch {
					return new Response(null, { status: 400 });
				}
				const parsed = backgroundJob.safeParse(value);
				if (!parsed.success) return new Response(null, { status: 400 });
				if (
					parsed.data.kind === "model-admission" &&
					process.env.MODEL_EXECUTION_ENABLED !== "1"
				)
					return new Response(null, { status: 503 });
				if (
					parsed.data.kind === "prepare" &&
					env.ENVIRONMENT_EXECUTION_ENABLED !== "1"
				)
					return new Response(null, { status: 503 });
				// A sent message's wake: claim and start its turn in this request.
				// A job runner object would add a new object's first call and an
				// alarm (1-2 s on the edge) before the claim; a repeated admission
				// is harmless, since a claim takes a turn once.
				if (parsed.data.kind === "model-admission") {
					await withDatabaseScope(
						env.HYPERDRIVE.connectionString,
						() => admitQueuedTurns(env),
						null,
					);
					return Response.json({ state: "done" }, { status: 202 });
				}
				// Re-admitting the same signed job is a no-op that reports its state.
				return Response.json(
					{ state: await startBackgroundJob(env, parsed.data) },
					{ status: 202 },
				);
			}
			if (new URL(request.url).pathname === "/pr-repair-event") {
				const secrets = prRepairIngressSecrets.safeParse(env);
				if (!secrets.success) return new Response(null, { status: 503 });
				return await withDatabaseScope(
					env.HYPERDRIVE.connectionString,
					() =>
						withBackgroundJobDispatcher(
							async (job) => {
								await startBackgroundJob(env, job);
							},
							() =>
								executeWorkflowRequest(
									request,
									secrets.data.PR_REPAIR_INGRESS_SECRET,
									() => {
										throw new Error("Repair intake does not run model steps.");
									},
								),
						),
					null,
				);
			}
			if (new URL(request.url).pathname === "/start") {
				if (request.method !== "POST")
					return new Response(null, { status: 404 });
				const secrets = executorSecrets.parse(env);
				if (secrets.MODEL_EXECUTION_ENABLED !== "1")
					return new Response(null, { status: 503 });
				let body: string;
				try {
					body = await readBoundedRequestBody(request, 1024);
				} catch {
					return new Response(null, { status: 413 });
				}
				if (
					!(await verifyDeliveryRequest(
						secrets.MODEL_WORKFLOW_SECRET,
						request,
						body,
					))
				)
					return new Response(null, { status: 401 });
				let value: unknown;
				try {
					value = JSON.parse(body);
				} catch {
					return new Response(null, { status: 400 });
				}
				const turn = workflowTurnSchema.safeParse(value);
				if (!turn.success) return new Response(null, { status: 400 });
				const scope = await withDatabaseScope(
					env.HYPERDRIVE.connectionString,
					() => resolveModelConversation({ ...turn.data, index: 1 }),
					null,
				);
				if (
					!scope ||
					!(await env.MODEL_CONVERSATIONS.getByName(
						modelConversationName(scope),
						durableObjectLocation(),
					).startTurn(scope, turn.data))
				)
					return new Response(null, { status: 409 });
				return new Response(null, { status: 202 });
			}
			if (new URL(request.url).pathname === "/environment/start") {
				if (request.method !== "POST")
					return new Response(null, { status: 404 });
				const config = environmentSecrets.safeParse(env);
				if (!config.success) return new Response(null, { status: 503 });
				let body: string;
				try {
					body = await readBoundedRequestBody(request, 4096);
				} catch {
					return new Response(null, { status: 413 });
				}
				if (
					!(await verifyDeliveryRequest(
						config.data.ENVIRONMENT_WORKFLOW_SECRET,
						request,
						body,
					))
				)
					return new Response(null, { status: 401 });
				let value: unknown;
				try {
					value = JSON.parse(body);
				} catch {
					return new Response(null, { status: 400 });
				}
				const parsed = environmentWorkflowRequest.safeParse(value);
				if (!parsed.success) return new Response(null, { status: 400 });
				await env.PROJECT_ENVIRONMENTS.getByName(
					parsed.data.workspaceId,
					durableObjectLocation(),
				).start(parsed.data);
				return new Response(null, { status: 202 });
			}
			// A background command exited: its guest asks for its chat's check now.
			if (path === BACKGROUND_EXIT_PATH) {
				if (request.method !== "POST")
					return new Response(null, { status: 404 });
				const config = backgroundExitSecrets.safeParse(env);
				if (!config.success) return new Response(null, { status: 503 });
				let body: string;
				try {
					body = await readBoundedRequestBody(request, 1024);
				} catch {
					return new Response(null, { status: 413 });
				}
				let value: unknown;
				try {
					value = JSON.parse(body);
				} catch {
					return new Response(null, { status: 400 });
				}
				const exit = backgroundExitRequest.safeParse(value);
				if (!exit.success) return new Response(null, { status: 400 });
				if (
					!(await verifyBackgroundExitToken(
						config.data.GIT_PROXY_SECRET,
						exit.data,
						request.headers.get(BACKGROUND_EXIT_TOKEN_HEADER) ?? "",
					))
				)
					return new Response(null, { status: 401 });
				// One job per command, ever: a repeated or replayed callback is a no-op.
				return Response.json(
					{
						state: await startBackgroundJob(env, {
							id: backgroundJobId(
								`background-exit:${exit.data.sessionId}:${exit.data.commandId}`,
							),
							kind: "background-wake",
							...exit.data,
						}),
					},
					{ status: 202 },
				);
			}
			if (isTurnBoxEdgePath(new URL(request.url).pathname))
				// A box's turn coordinates with, and publishes to, its chat's
				// object through this same Worker's realtime routes: in process,
				// since a Worker cannot fetch its own public URL.
				return await withExecutorBinding(
					(input, init): Promise<Response> =>
						(
							edgeExecutorWorker.fetch as (
								request: Request,
								env: EdgeExecutorEnvironment,
								ctx?: ExecutionContext,
							) => Promise<Response>
						)(new Request(input, init), env, ctx),
					async () => routeTurnBoxWorker(request, env),
				);
			if (isClaudeCodeEdgePath(new URL(request.url).pathname))
				return await routeClaudeCodeEdge(
					request,
					env,
					ctx ? (promise) => ctx.waitUntil(promise) : undefined,
				);
			if (new URL(request.url).pathname === MACHINE_GIT_GRANT_PATH) {
				const config = gitProxySecrets.safeParse(env);
				if (!config.success) return new Response(null, { status: 503 });
				return withStepTrace({ git: "grant" }, () =>
					withDatabaseScope(
						env.HYPERDRIVE.connectionString,
						() =>
							answerMachineGitGrant(
								request,
								config.data.GIT_PROXY_SECRET,
								machineGitSources,
							),
						null,
					),
				);
			}
			if (new URL(request.url).pathname.startsWith("/git/")) {
				const config = gitProxySecrets.safeParse(env);
				if (!config.success) return new Response(null, { status: 503 });
				const gitPath = new URL(request.url).pathname;
				const scoped =
					<A extends unknown[], T>(run: (...args: A) => Promise<T>) =>
					(...args: A) =>
						withDatabaseScope(
							env.HYPERDRIVE.connectionString,
							() => run(...args),
							null,
						);
				const machine = machineGitHooks(machineGitSources);
				return withStepTrace(
					{
						git: gitPath.endsWith("/info/refs")
							? "refs"
							: gitPath.split("/").at(-1),
					},
					() =>
						proxyGithubGit(
							request,
							config.data.GIT_PROXY_SECRET,
							(grant) =>
								timed("git:authorize", () =>
									withDatabaseScope(
										env.HYPERDRIVE.connectionString,
										() => authorizeGitProxy(grant),
										null,
									),
								),
							fetch,
							(nonce, expiresAt) =>
								withDatabaseScope(
									env.HYPERDRIVE.connectionString,
									() => claimGitProxyGrant(nonce, expiresAt),
									null,
								),
							{
								authorize: scoped((grant) =>
									timed("git:authorizeMachine", () => machine.authorize(grant)),
								),
								defaultBranchPush: scoped(machine.defaultBranchPush),
							},
						),
				);
			}
			const secrets = executorSecrets.parse(env);
			stage = "model-routing";
			return await routeModelConversationStep(
				request,
				secrets.MODEL_WORKFLOW_SECRET,
				(step) => {
					if (secrets.MODEL_EXECUTION_ENABLED !== "1")
						throw new Error("Model execution cutover is not enabled.");
					stage = "model-owner";
					return withDatabaseScope(
						env.HYPERDRIVE.connectionString,
						() => resolveModelConversation(step),
						null,
					);
				},
				async (scope, authenticated) => {
					stage = "model-chat";
					return await env.MODEL_CONVERSATIONS.getByName(
						modelConversationName(scope),
						durableObjectLocation(),
					).fetch(authenticated);
				},
			);
		} catch (error) {
			// SQL/provider diagnostics may contain credentials; never expose them over HTTP.
			console.warn("Edge execution unavailable.", {
				stage,
				code:
					error &&
					typeof error === "object" &&
					"code" in error &&
					/^[A-Z0-9]{3,24}$/.test(String(error.code))
						? String(error.code)
						: "unclassified",
			});
			return new Response(null, { status: 503 });
		}
	},
};
export default edgeExecutorWorker;
