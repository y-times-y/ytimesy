import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";
import {
	type BackgroundJob,
	backgroundJob,
	interruptedJobDecision,
} from "../../domain/background-job";
import { modelConversationName } from "../../domain/model-conversation-routing";
import { withBackgroundJobDispatcher } from "../adapters/background-job-dispatch";
import { withCodexSubscriptionEgress } from "../adapters/codex-subscription-transport";
import { withDatabaseScope } from "../adapters/database-scope";
import { registerAuthEmailBinding } from "../adapters/email";
import { readFreestyleApiKey } from "../adapters/freestyle/api-key";
import { createFreestyleWorkspaceMachines } from "../adapters/freestyle/workspace-machines";
import { registerMemoryEmbeddings } from "../adapters/memory-embeddings";
import { registerMemoryRepos } from "../adapters/memory-repos";
import {
	admitQueuedTurnsWith,
	type TurnStartRequest,
} from "../adapters/turn-start";
import { deliverBackgroundJob } from "../services/background-job-delivery";
import { durableObjectLocation } from "./durable-object-location";
import type { EdgeExecutorEnvironment } from "./environment";
import { withEdgeModelEndpoints } from "./model-endpoint";

const PEER_RETRY_MS = 15_000;
const PEER_ATTEMPTS = 240;
const RECORD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Background jobs are short (seconds to a few minutes), so they run inside one
 * Worker invocation: the cron handler runs its periodic jobs directly, and
 * on-demand jobs run in a per-job BackgroundJobRunner. Long work is handed to
 * the chat or project-environment Durable Objects instead (see docs/edge-architecture-migration.md).
 */
export function runBackgroundJob(
	env: EdgeExecutorEnvironment,
	job: BackgroundJob,
): Promise<"delivered" | "pending"> {
	return withDatabaseScope(
		env.HYPERDRIVE.connectionString,
		() =>
			withBackgroundJobDispatcher(
				async (next) => {
					await startBackgroundJob(env, next);
				},
				async () => {
					if (job.kind === "model-admission") {
						await admitQueuedTurns(env);
						return "delivered";
					}
					if (job.kind === "prepare") {
						if (env.ENVIRONMENT_EXECUTION_ENABLED !== "1")
							throw new Error("Environment execution is disabled.");
						await env.PROJECT_ENVIRONMENTS.getByName(
							job.workspaceId,
							durableObjectLocation(),
						).start({
							requestId: job.id,
							workspaceId: job.workspaceId,
							force: job.force,
							repairModel: job.repairModel,
						});
						return "delivered";
					}
					// Memory jobs and held sends run on the user's model route, which
					// may be their ChatGPT plan.
					if (job.kind === "memory" || job.kind === "held-sends")
						return withCodexSubscriptionEgress(
							(input, options) => env.CODEX_EGRESS.fetch(input, options),
							() =>
								withEdgeModelEndpoints(() =>
									deliverBackgroundJob(
										createFreestyleWorkspaceMachines(
											Effect.runSync(readFreestyleApiKey()),
										),
										job,
									),
								),
						);
					return withEdgeModelEndpoints(() =>
						deliverBackgroundJob(
							createFreestyleWorkspaceMachines(
								Effect.runSync(readFreestyleApiKey()),
							),
							job,
						),
					);
				},
			),
		null,
	);
}

/**
 * Claims queued chat turns (within the concurrency limits) and starts each in
 * its chat's ModelConversation. Safe to repeat: a claim takes a turn once, so
 * a second pass finds nothing. Runs inside a database scope.
 */
export async function admitQueuedTurns(env: EdgeExecutorEnvironment) {
	if (process.env.MODEL_EXECUTION_ENABLED !== "1")
		throw new Error("Model execution is disabled.");
	await admitQueuedTurnsWith((turn) => startClaimedTurn(env, turn));
}

/** Hands a claimed turn to its chat's loop; idempotent for the same turn and lease. */
export function startClaimedTurn(
	env: EdgeExecutorEnvironment,
	turn: TurnStartRequest,
) {
	const scope = { userId: turn.userId, sessionId: turn.sessionId };
	return env.MODEL_CONVERSATIONS.getByName(
		modelConversationName(scope),
		durableObjectLocation(),
	).startTurn(scope, { turnId: turn.turnId, leaseId: turn.leaseId });
}

/** Idempotent by job ID: admitting the same job again only reports its state. */
export function startBackgroundJob(
	env: EdgeExecutorEnvironment,
	job: BackgroundJob,
): Promise<JobRecord["state"]> {
	return env.BACKGROUND_JOBS.getByName(job.id, durableObjectLocation()).start(
		backgroundJob.parse(job),
	);
}

type JobRecord = {
	job: BackgroundJob;
	state: "queued" | "running" | "done" | "failed";
	attempts: number;
	/** Runs a Worker restart cut off; a replayable job runs again until MAX_JOB_INTERRUPTIONS. */
	interruptions?: number;
};

/**
 * One instance per on-demand job. Only an explicitly pending peer message is
 * retried after a failure. A run interrupted mid-way (a deploy) runs again
 * when its kind is safe to repeat (interruptedJobDecision); any other fails
 * closed so an uncertain side effect is never replayed.
 */
export class BackgroundJobRunner extends DurableObject<EdgeExecutorEnvironment> {
	constructor(ctx: DurableObjectState, env: EdgeExecutorEnvironment) {
		super(ctx, env);
		// The delivery job retries queued auth email through this binding.
		registerAuthEmailBinding(env.EMAIL);
		registerMemoryRepos(env.ARTIFACTS);
		registerMemoryEmbeddings(env.AI);
	}

	async start(job: BackgroundJob): Promise<JobRecord["state"]> {
		const existing = await this.ctx.storage.get<JobRecord>("job");
		if (existing) return existing.state;
		await this.ctx.storage.put<JobRecord>("job", {
			job,
			state: "queued",
			attempts: 0,
		});
		await this.ctx.storage.setAlarm(Date.now());
		return "queued";
	}

	async alarm() {
		let record = await this.ctx.storage.get<JobRecord>("job");
		if (!record) return;
		if (record.state === "done" || record.state === "failed") {
			await this.ctx.storage.deleteAll();
			return;
		}
		if (record.state === "running") {
			// The platform re-fires an alarm whose handler died (a deploy, a
			// crash). A job safe to repeat runs again; any other fails closed,
			// since its effects are unknown.
			const interruptions = (record.interruptions ?? 0) + 1;
			if (
				interruptedJobDecision(record.job.kind, interruptions - 1) === "fail"
			) {
				await this.finish(record, "failed", "interrupted");
				return;
			}
			console.warn("Background job interrupted; running it again.", {
				id: record.job.id,
				kind: record.job.kind,
				interruptions,
			});
			record = { ...record, interruptions };
		}
		await this.ctx.storage.put<JobRecord>("job", {
			...record,
			state: "running",
		});
		let outcome: "delivered" | "pending";
		try {
			outcome = await runBackgroundJob(this.env, record.job);
		} catch (error) {
			// Messages can carry provider or SQL diagnostics; log the class only.
			await this.finish(
				record,
				"failed",
				`error:${error instanceof Error ? error.name : "unknown"}`,
			);
			return;
		}
		if (outcome === "delivered") {
			await this.finish(record, "done");
			return;
		}
		const attempts = record.attempts + 1;
		if (attempts >= PEER_ATTEMPTS) {
			await this.finish(record, "failed", "peer delivery deadline exceeded");
			return;
		}
		await this.ctx.storage.put<JobRecord>("job", {
			...record,
			state: "queued",
			attempts,
		});
		await this.ctx.storage.setAlarm(Date.now() + PEER_RETRY_MS);
	}

	/** Keeps the record for a week so a repeated admission stays a no-op. */
	private async finish(
		record: JobRecord,
		state: "done" | "failed",
		reason?: string,
	) {
		if (reason)
			console.warn("Background job failed.", {
				id: record.job.id,
				kind: record.job.kind,
				reason,
			});
		await this.ctx.storage.put<JobRecord>("job", { ...record, state });
		await this.ctx.storage.setAlarm(Date.now() + RECORD_RETENTION_MS);
	}
}
