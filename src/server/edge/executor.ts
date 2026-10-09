/// <reference path="../../../.ytimesy/edge-executor-runtime.d.ts" />
import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";
import { z } from "zod";
import { backgroundJob } from "../../domain/background-job";
import { readBoundedRequestBody } from "../../domain/bounded-request-body";
import { claimConversationStep } from "../../domain/conversation-step-receipts";
import { verifyDeliveryRequest } from "../../domain/delivery-auth";
import { environmentWorkflowRequest } from "../../domain/environment-workflow";
import { proxyGithubGit } from "../../domain/github-git-proxy";
import {
	modelConversationName,
	routeModelConversationStep,
} from "../../domain/model-conversation-routing";
import {
	type WorkflowStep,
	workflowTurnSchema,
} from "../../domain/model-workflow";
import { ConversationRoom, routeRealtimeRequest } from "../../realtime/worker";
import type { ApiTurn } from "../adapters/api-turns";
import {
	backgroundJobId,
	withBackgroundJobDispatcher,
} from "../adapters/background-job-dispatch";
import { withCodexSubscriptionEgress } from "../adapters/codex-subscription-transport";
import { withConversationProgressWake } from "../adapters/conversation-progress-wake";
import { withConversationTurnCoordinator } from "../adapters/conversation-turn-control";
import { database } from "../adapters/database";
import { withDatabaseScope } from "../adapters/database-scope";
import { readFreestyleApiKey } from "../adapters/freestyle/api-key";
import { createFreestyleWorkspaceMachines } from "../adapters/freestyle/workspace-machines";
import type { claimModelWorkflowStep } from "../adapters/model-workflow-steps";
import { withConversationPublisher } from "../adapters/realtime-delivery";
import { relayConversationDeliveriesOnce } from "../jobs/conversation-delivery";
import { executeWorkflowRequest } from "../jobs/model-workflow-executor";
import { SqliteConversationSteps } from "./conversation-step-storage";
import type { EdgeExecutorEnvironment } from "./environment";
import { authorizeGitProxy } from "./github-git-authorization";
import { withEdgeModelEndpoints } from "./model-endpoint";

export { BackgroundJobWorkflow } from "./background-job-workflow";
export { ProjectEnvironmentWorkflow } from "./environment-workflow";
export { EdgeModelTurnWorkflow } from "./model-turn-workflow";

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
	async alarm() {
		await this.room.alarm();
	}
	private async claim(
		step: WorkflowStep,
	): ReturnType<typeof claimModelWorkflowStep> {
		const receipt = this.steps.read(step);
		if (receipt?.state === "done" && receipt.outcome)
			return { kind: "done", outcome: receipt.outcome };
		if (receipt) return { kind: "unavailable" };
		const turn = (
			await database().query<
				ApiTurn & { fresh: boolean; cancel_requested: boolean; legacy: boolean }
			>(
				`select t.*,heartbeat_at>=now()-interval '45 seconds' as fresh,
			 exists(select 1 from model_workflow_step s where s.turn_id=t.id) as legacy
			 from api_turn t where t.id=$1 and t.lease_id=$2 and t.executor='durable-object'`,
				[step.turnId, step.leaseId],
			)
		).rows[0];
		if (!turn || turn.legacy) return { kind: "unavailable" };
		if (
			turn.state === "completed" ||
			turn.state === "failed" ||
			turn.state === "cancelled"
		)
			return { kind: "done", outcome: turn.state };
		if (turn.state !== "running" || !turn.fresh) return { kind: "unavailable" };
		if (turn.cancel_requested) return { kind: "cancelled", turn };
		// No await between reading and inserting: concurrent requests cannot claim the same step.
		const claimed = claimConversationStep(this.steps, step);
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
				async (scope, authenticated) =>
					this.bindIdentity(scope)
						? this.room.fetch(authenticated)
						: new Response(null, { status: 403 }),
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
									await this.env.BACKGROUND_JOBS.createBatch([
										{ id: job.id, params: job },
									]);
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
		this.room = new ConversationRoom(ctx);
		this.steps = new SqliteConversationSteps(ctx.storage.sql);
		ctx.storage.sql.exec(
			"create table if not exists conversation_identity(id integer primary key check(id=1),name text not null)",
		);
	}
}

export default {
	async scheduled(
		controller: ScheduledController,
		env: EdgeExecutorEnvironment,
	) {
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
		await env.BACKGROUND_JOBS.createBatch(
			jobs
				.filter(
					(job) =>
						job.kind !== "model-admission" ||
						process.env.MODEL_EXECUTION_ENABLED === "1",
				)
				.map((job) => ({ id: job.id, params: job })),
		);
	},
	async fetch(request: Request, env: EdgeExecutorEnvironment) {
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
				await env.BACKGROUND_JOBS.createBatch([
					{ id: parsed.data.id, params: parsed.data },
				]);
				return new Response(null, { status: 202 });
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
				if (!scope) return new Response(null, { status: 409 });
				await env.MODEL_TURNS.createBatch([
					{ id: `${turn.data.turnId}-${turn.data.leaseId}`, params: turn.data },
				]);
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
				await env.PROJECT_ENVIRONMENTS.createBatch([
					{ id: parsed.data.requestId, params: parsed.data },
				]);
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
