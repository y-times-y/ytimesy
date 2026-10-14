/// <reference path="../../../.ytimesy/edge-executor-runtime.d.ts" />
import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";
import { z } from "zod";
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
	type WorkflowStep,
	type WorkflowTurn,
	workflowTurnSchema,
} from "../../domain/model-workflow";
import { ConversationRoom, routeRealtimeRequest } from "../../realtime/worker";
import {
	type ApiTurn,
	cancelWaitingApiTurn,
	refreshWaitingApiTurns,
} from "../adapters/api-turns";
import {
	backgroundJobId,
	withBackgroundJobDispatcher,
} from "../adapters/background-job-dispatch";
import { withCodexSubscriptionEgress } from "../adapters/codex-subscription-transport";
import { withConversationProgressWake } from "../adapters/conversation-progress-wake";
import { withConversationTurnCoordinator } from "../adapters/conversation-turn-control";
import { database } from "../adapters/database";
import { withDatabaseScope } from "../adapters/database-scope";
import { useAuthEmailBinding } from "../adapters/email";
import { readFreestyleApiKey } from "../adapters/freestyle/api-key";
import { createFreestyleWorkspaceMachines } from "../adapters/freestyle/workspace-machines";
import { withConversationPublisher } from "../adapters/realtime-delivery";
import { withTurnHistoryMirror } from "../adapters/turn-history-mirror";
import { relayConversationDeliveriesOnce } from "../jobs/conversation-delivery";
import {
	executeModelStep,
	executeWorkflowRequest,
	type WorkflowStepClaim,
} from "../jobs/model-workflow-executor";
import { runBackgroundJob, startBackgroundJob } from "./background-jobs";
import { SqliteConversationSteps } from "./conversation-step-storage";
import type { EdgeExecutorEnvironment } from "./environment";
import { authorizeGitProxy } from "./github-git-authorization";
import { withEdgeModelEndpoints } from "./model-endpoint";
import { TurnHistoryCache } from "./turn-history-cache";
import { type QueuedTurn, SqliteTurnQueue } from "./turn-queue";

export { BackgroundJobRunner } from "./background-jobs";
export { ProjectEnvironment } from "./project-environment";

// Validate scalar secrets separately: generated ProcessEnv requirements must not
// force application credentials into the deliberately sanitized Git subprocess environment.
const executorSecrets = z.object({
	DATABASE_URL: z.string().min(1),
	DATABASE_SSL_CA: z.string().optional(),
	MODEL_WORKFLOW_SECRET: z.string().min(32),
	MODEL_EXECUTION_ENABLED: z.enum(["0", "1"]).default("0"),
});
const gitProxySecrets = z.object({
	DATABASE_URL: z.string().min(1),
	DATABASE_SSL_CA: z.string().optional(),
	GIT_PROXY_SECRET: z.string().min(32),
	GIT_PROXY_ENABLED: z.literal("1"),
});
const environmentSecrets = z.object({
	ENVIRONMENT_WORKFLOW_SECRET: z.string().min(32),
	ENVIRONMENT_EXECUTION_ENABLED: z.literal("1"),
});

/** One step must finish inside a single alarm, which Cloudflare stops after 15 minutes. */
const STEP_BUDGET_MS = 14 * 60 * 1000;
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

/** Fresh turns use DO receipts; legacy Node turns must finish on their original executor. */
export class ModelConversation extends DurableObject<EdgeExecutorEnvironment> {
	private readonly steps: SqliteConversationSteps;
	private readonly history: TurnHistoryCache;
	private readonly queue: SqliteTurnQueue;
	private readonly room: ConversationRoom;
	private bindIdentity(scope: { userId: string; sessionId: string }) {
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
	 * A deploy or crash that resets this object mid-step makes Cloudflare re-run
	 * the alarm; the step's receipt is still "processing", so it is resumed.
	 */
	async alarm() {
		const due = new Set(
			this.ctx.storage.sql
				.exec<{ purpose: string }>(
					"select purpose from conversation_wake where at<=?",
					Date.now(),
				)
				.toArray()
				.map((row) => row.purpose),
		);
		if (due.has("room")) {
			await this.wake("room", null);
			await this.room.alarm();
		}
		if (due.has("turn")) await this.advanceTurn();
	}
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
	private async advanceTurn() {
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
															this.claim(claimed, resumed),
														complete: async (finished, result) => {
															if (!this.steps.finish(finished, result))
																throw new Error(
																	"Conversation receipt was not saved.",
																);
														},
													},
													AbortSignal.timeout(STEP_BUDGET_MS),
													resume,
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
					legacy: boolean;
					version: string;
				}
			>(
				`select t.id,t.session_id,t.user_id,t.connection_id,t.connection_revision,t.model_id,t.settings,t.failover,
			 t.state,t.lease_id,t.cancel_requested,t.updated_at::text as version,
			 heartbeat_at>=now()-interval '45 seconds' as fresh,
			 exists(select 1 from model_workflow_step s where s.turn_id=t.id) as legacy
			 from api_turn t where t.id=$1 and t.lease_id=$2 and t.executor='durable-object'`,
				[step.turnId, leaseId],
			)
		).rows[0];
		if (!row || row.legacy) return { kind: "unavailable" };
		if (
			row.state === "completed" ||
			row.state === "failed" ||
			row.state === "cancelled"
		)
			return { kind: "done", outcome: row.state };
		if (row.state !== "running" || !row.fresh) return { kind: "unavailable" };
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
		if (
			path === "/snapshot" ||
			path === "/stream" ||
			path.startsWith("/turn/")
		) {
			const secret = process.env.YTIMESY_REALTIME_SECRET;
			if (!secret || secret.length < 32)
				return new Response(null, { status: 503 });
			return routeRealtimeRequest(
				request,
				secret,
				async (scope, authenticated) => {
					if (!this.bindIdentity(scope))
						return new Response(null, { status: 403 });
					if (path === "/turn/cancel") {
						const control = turnControlSchema.safeParse(
							await authenticated.clone().json(),
						);
						if (control.success && (await this.cancelWaiting(control.data)))
							return new Response(null, { status: 204 });
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
	}
}

export default {
	async scheduled(
		controller: ScheduledController,
		env: EdgeExecutorEnvironment,
	) {
		useAuthEmailBinding(env.EMAIL);
		if (
			process.env.BACKGROUND_EXECUTION_ENABLED !== "1" ||
			process.env.YTIMESY_BACKGROUND_CRON_ENABLED !== "1"
		)
			return;
		const minute = Math.floor(controller.scheduledTime / 60_000);
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
			...(["task-event", "pr-repair", "work-plan"] as const).map((kind) =>
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
		for (const [index, result] of results.entries())
			if (result.status === "rejected")
				console.warn("Scheduled job failed.", {
					kind: jobs[index].kind,
					action: "action" in jobs[index] ? jobs[index].action : undefined,
				});
	},
	async fetch(request: Request, env: EdgeExecutorEnvironment) {
		useAuthEmailBinding(env.EMAIL);
		let stage = "ingress";
		try {
			const path = new URL(request.url).pathname;
			if (
				path === "/snapshot" ||
				path === "/stream" ||
				path.startsWith("/turn/")
			) {
				const secret = process.env.YTIMESY_REALTIME_SECRET;
				if (!secret || secret.length < 32)
					return new Response(null, { status: 503 });
				return routeRealtimeRequest(request, secret, (scope, authenticated) =>
					env.MODEL_CONVERSATIONS.getByName(modelConversationName(scope)).fetch(
						authenticated,
					),
				);
			}
			if (new URL(request.url).pathname === "/jobs/start") {
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
				// Re-admitting the same signed job is a no-op that reports its state.
				return Response.json(
					{ state: await startBackgroundJob(env, parsed.data) },
					{ status: 202 },
				);
			}
			if (new URL(request.url).pathname === "/pr-repair-event") {
				const secrets = executorSecrets.parse(env);
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
									secrets.MODEL_WORKFLOW_SECRET,
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
				await env.PROJECT_ENVIRONMENTS.getByName(parsed.data.workspaceId).start(
					parsed.data,
				);
				return new Response(null, { status: 202 });
			}
			if (new URL(request.url).pathname.startsWith("/git/")) {
				const config = gitProxySecrets.safeParse(env);
				if (!config.success) return new Response(null, { status: 503 });
				return proxyGithubGit(request, config.data.GIT_PROXY_SECRET, (grant) =>
					withDatabaseScope(
						env.HYPERDRIVE.connectionString,
						() => authorizeGitProxy(grant),
						null,
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
