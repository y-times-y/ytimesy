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
import { claimConversationStep } from "../../domain/conversation-step-receipts";
import { turnControlSchema } from "../../domain/conversation-turn-control";
import { verifyDeliveryRequest } from "../../domain/delivery-auth";
import { environmentWorkflowRequest } from "../../domain/environment-workflow";
import { proxyGithubGit } from "../../domain/github-git-proxy";
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
import { BUILD_ID } from "../../lib/build-id";
import {
	ConversationRoom,
	isRealtimeRoute,
	routeRealtimeRequest,
} from "../../realtime/worker";
import {
	type ApiTurn,
	cancelWaitingApiTurn,
	refreshWaitingApiTurns,
	turnPastDeadlineSql,
} from "../adapters/api-turns";
import {
	backgroundJobId,
	withBackgroundJobDispatcher,
} from "../adapters/background-job-dispatch";
import {
	probeCodexEgress,
	withCodexSubscriptionEgress,
} from "../adapters/codex-subscription-transport";
import { withConversationProgressWake } from "../adapters/conversation-progress-wake";
import { withConversationTurnCoordinator } from "../adapters/conversation-turn-control";
import { database } from "../adapters/database";
import { withDatabaseScope } from "../adapters/database-scope";
import { registerAuthEmailBinding } from "../adapters/email";
import { readFreestyleApiKey } from "../adapters/freestyle/api-key";
import { createFreestyleWorkspaceMachines } from "../adapters/freestyle/workspace-machines";
import { registerMemoryEmbeddings } from "../adapters/memory-embeddings";
import { registerMemoryRepos } from "../adapters/memory-repos";
import { withConversationPublisher } from "../adapters/realtime-delivery";
import { withTurnHistoryMirror } from "../adapters/turn-history-mirror";
import { turnStartRequest } from "../adapters/turn-start";
import { relayConversationDeliveriesOnce } from "../jobs/conversation-delivery";
import {
	executeModelStep,
	executeWorkflowRequest,
	type WorkflowStepClaim,
} from "../jobs/model-workflow-executor";
import { provideCodeModeWasmModule } from "../services/code-mode-sandbox";
import { abortLiveTurn } from "../services/live-turn-abort";
import { alertCronFailure } from "../services/operational-alerts";
import { timed, withStepTrace } from "../services/step-timing";
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
} from "./claude-code-routes";
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
import { TurnHistoryCache } from "./turn-history-cache";
import { type QueuedTurn, SqliteTurnQueue } from "./turn-queue";

export { BackgroundJobRunner } from "./background-jobs";
export { ProjectEnvironment } from "./project-environment";

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

/** Consecutive unfinished attempts (restarts or infrastructure errors) of one step before the turn is abandoned. */
const MAX_STEP_RESUMES = 3;
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
	const result = await database().query<{ userId: string; sessionId: string }>(
		`select t.user_id as "userId",t.session_id as "sessionId"
		 from api_turn t join agent_session s on s.id=t.session_id and s.user_id=t.user_id
		 where t.id=$1 and t.lease_id=$2 and t.executor='durable-object'`,
		[step.turnId, step.leaseId],
	);
	return result.rows[0] ?? null;
}

const PURGE_TOMBSTONE_TABLE =
	"create table if not exists conversation_tombstone(id integer primary key check(id=1),purged_at integer not null)";

/** Fresh turns use DO receipts; legacy Node turns must finish on their original executor. */
export class ModelConversation extends DurableObject<EdgeExecutorEnvironment> {
	private readonly steps: SqliteConversationSteps;
	private readonly history: TurnHistoryCache;
	private readonly queue: SqliteTurnQueue;
	private readonly room: ConversationRoom;
	/**
	 * The chat was deleted: its tombstone (kept in SQLite across restarts)
	 * refuses every later request, turn, step and alarm, so an in-flight turn
	 * cannot recreate its state after the purge.
	 */
	private purged = false;
	private bindIdentity(scope: { userId: string; sessionId: string }) {
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
		return true;
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
				withConversationPublisher(
					async (snapshot) => {
						if (
							snapshot.userId !== scope.userId ||
							snapshot.sessionId !== scope.sessionId
						)
							return false;
						const response = await this.room.fetch(
							new Request("https://chat.internal/snapshot", {
								method: "POST",
								body: JSON.stringify(snapshot),
							}),
						);
						return response.status === 204;
					},
					() =>
						withCodexSubscriptionEgress(
							(input, options) => this.env.CODEX_EGRESS.fetch(input, options),
							() => withEdgeModelEndpoints(run),
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
	) {
		if (!this.bindIdentity(scope)) return false;
		const active = this.activeTurn();
		if (active?.turnId === turn.turnId) return active.leaseId === turn.leaseId;
		if (active) return this.queue.add({ ...scope, ...turn });
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
		await this.wake("turn", Date.now());
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
	/** The turn loop and the room's lease expiry share this object's single alarm. */
	private async wake(purpose: "turn" | "room", at: number | null) {
		if (this.purged) return;
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
			await this.room.alarm();
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
			await this.advanceTurn(now - turnAt);
		} finally {
			this.stepping = false;
		}
	}
	/** A step of this object's turn is running in this instance. */
	private stepping = false;
	/** Runs after the turn released its room lease, so a waiting turn can start. */
	private async endTurn() {
		this.history.clear();
		this.ctx.storage.sql.exec("delete from turn_loop");
		const next = this.queue.take();
		if (next) {
			await this.refreshWaiting([next]);
			await this.beginTurn(next);
		} else await this.wake("turn", null);
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
		if (active.resumes >= MAX_STEP_RESUMES) {
			// Stop driving it; lease expiry marks the turn failed and tells the user.
			console.warn("Chat step kept failing; turn abandoned.", {
				index: step.index,
			});
			return this.endTurn();
		}
		const resume = this.steps.read(step)?.state === "processing";
		// Counts consecutive attempts that did not finish this step.
		this.ctx.storage.sql.exec("update turn_loop set resumes=resumes+1");
		if (executorSecrets.parse(this.env).MODEL_EXECUTION_ENABLED !== "1")
			return this.endTurn();
		let outcome: Awaited<ReturnType<typeof executeModelStep>>;
		const stopRefreshing = this.keepWaitingTurnsFresh();
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
											(turnId, version, written) =>
												this.history.write(turnId, version, written),
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
		} catch {
			// Unknown outcome: a started step keeps its receipt and is resumed next time.
			console.warn("Chat step failed; retrying.", { index: step.index });
			return this.wake("turn", Date.now() + 5_000 * (active.resumes + 1));
		} finally {
			stopRefreshing();
		}
		if (outcome === "continue") {
			this.ctx.storage.sql.exec(
				"update turn_loop set step_index=step_index+1,resumes=0",
			);
			return this.wake("turn", Date.now());
		}
		await this.endTurn();
		if (
			outcome !== "unavailable" &&
			process.env.BACKGROUND_EXECUTION_ENABLED === "1"
		)
			await startBackgroundJob(this.env, {
				id: backgroundJobId(`completed:${step.turnId}:${step.leaseId}`),
				kind: "model-admission",
			});
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
				Omit<ApiTurn, "messages" | "items"> & {
					fresh: boolean;
					cancel_requested: boolean;
					past_deadline?: boolean;
					legacy: boolean;
					version: string;
				}
			>(
				`select t.id,t.session_id,t.user_id,t.connection_id,t.connection_revision,t.model_id,t.settings,t.failover,
			 t.state,t.lease_id,t.cancel_requested,t.updated_at::text as version,
			 (extract(epoch from t.created_at)*1000)::float8 as queued_at_ms,
			 heartbeat_at>=now()-interval '45 seconds' as fresh,
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
		let history = this.history.read(row.id, row.version);
		if (!history) {
			const loaded = (
				await database().query<Pick<ApiTurn, "messages" | "items">>(
					"select messages,items from api_turn where id=$1 and lease_id=$2",
					[row.id, leaseId],
				)
			).rows[0];
			if (!loaded) return { kind: "unavailable" };
			history = loaded;
			this.history.write(row.id, row.version, loaded);
		}
		const turn = { ...row, ...history };
		if (turn.cancel_requested) return { kind: "cancelled", turn };
		// No await between reading and inserting: concurrent requests cannot claim the same step.
		const claimed = claimConversationStep(this.steps, step, Date.now(), resume);
		return claimed.kind === "claimed" ? { ...claimed, turn } : claimed;
	}
	async fetch(request: Request) {
		const path = new URL(request.url).pathname;
		// The VM's Claude Code asking for ytimesy's tools; the turn's step runs them.
		if (path === CLAUDE_CODE_MCP_PATH) {
			if (this.purged) return new Response(null, { status: 410 });
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
						// The room holds the stop; the turn running here stops now.
						if (control.success && response.status === 204)
							abortLiveTurn(control.data.turnId);
						return response;
					}
					return this.room.fetch(authenticated);
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

	constructor(ctx: DurableObjectState, env: EdgeExecutorEnvironment) {
		super(ctx, env);
		registerMemoryRepos(env.ARTIFACTS);
		registerMemoryEmbeddings(env.AI);
		this.room = new ConversationRoom(ctx, (at: number | null) =>
			this.wake("room", at),
		);
		this.steps = new SqliteConversationSteps(ctx.storage.sql);
		this.history = new TurnHistoryCache(ctx.storage.sql);
		this.queue = new SqliteTurnQueue(ctx.storage.sql);
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

export default {
	async scheduled(
		controller: ScheduledController,
		env: EdgeExecutorEnvironment,
	) {
		registerAuthEmailBinding(env.EMAIL);
		registerMemoryRepos(env.ARTIFACTS);
		registerMemoryEmbeddings(env.AI);
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
	) {
		registerAuthEmailBinding(env.EMAIL);
		registerMemoryRepos(env.ARTIFACTS);
		registerMemoryEmbeddings(env.AI);
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
				return new Response(null, {
					status: (await startClaimedTurn(env, turn.data)) ? 204 : 409,
				});
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
