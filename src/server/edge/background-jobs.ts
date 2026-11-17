import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";
import {
	type BackgroundJob,
	backgroundJob,
	interruptedJobDecision,
} from "../../domain/background-job";
import {
	BUDGET_PAUSED_MESSAGE,
	globalBudgetMode,
	isSpendingCapError,
} from "../../domain/cloudflare-budget";
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
import {
	deferralDelayMs,
	peerDeadlineReached,
	retryDelayMs,
	tryAdmitJob,
} from "./background-job-admission";
import {
	JobTimeLimitReached,
	runWithJobTimeLimit,
} from "./background-job-time-limit";
import { budgetAdmission } from "./budget-admission";
import { durableObjectLocation } from "./durable-object-location";
import type { EdgeExecutorEnvironment } from "./environment";
import { withEdgeModelEndpoints } from "./model-endpoint";
import { registerUserHubNotes } from "./user-hub-notes-binding";

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
					// Memory jobs, held sends and a project's setup start run on the
					// user's model route, which may be their ChatGPT plan.
					if (
						job.kind === "memory" ||
						job.kind === "held-sends" ||
						job.kind === "project-setup"
					)
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

/**
 * Hands a claimed turn to its chat's loop; idempotent for the same turn and
 * lease. "held": the monthly compute budget (or the global pause) keeps the
 * turn queued; the caller releases its claim. A turn already running is
 * never asked about.
 */
export async function startClaimedTurn(
	env: EdgeExecutorEnvironment,
	turn: TurnStartRequest,
): Promise<boolean | "held" | "paused"> {
	const scope = { userId: turn.userId, sessionId: turn.sessionId };
	const admission = await budgetAdmission(env, turn.userId);
	if (admission.action === "hold") {
		console.warn("Turn held by the compute budget.", {
			message: admission.message,
		});
		return admission.message === BUDGET_PAUSED_MESSAGE ? "paused" : "held";
	}
	try {
		return await env.MODEL_CONVERSATIONS.getByName(
			modelConversationName(scope),
			durableObjectLocation(),
		).startTurn(
			scope,
			{ turnId: turn.turnId, leaseId: turn.leaseId },
			{ degraded: admission.degraded },
		);
	} catch (error) {
		// Cloudflare's account spending cap: the same message, not a generic failure.
		if (isSpendingCapError(error)) return "held";
		throw error;
	}
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

/** Background kinds that wait while the compute budget is degraded or paused globally. */
const NON_ESSENTIAL_JOB_KINDS: ReadonlySet<string> = new Set([
	"maintenance",
	"memory",
	"pr-evidence",
]);

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
		registerUserHubNotes(env);
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
		// The global compute kill-switch (YTIMESY_CF_BUDGET_GLOBAL=degrade|pause):
		// non-essential jobs wait on an alarm (no active time) and keep their attempts.
		if (
			NON_ESSENTIAL_JOB_KINDS.has(record.job.kind) &&
			globalBudgetMode(process.env.YTIMESY_CF_BUDGET_GLOBAL) !== "off"
		) {
			await this.ctx.storage.put<JobRecord>("job", {
				...record,
				state: "queued",
			});
			await this.ctx.storage.setAlarm(Date.now() + 30 * 60_000);
			return;
		}
		// Memory-heavy kinds share the isolate's budget with other jobs; one
		// that does not fit waits on an alarm (no active time) and keeps its attempts.
		const release = tryAdmitJob(record.job.kind);
		if (!release) {
			await this.ctx.storage.put<JobRecord>("job", {
				...record,
				state: "queued",
			});
			await this.ctx.storage.setAlarm(Date.now() + deferralDelayMs());
			return;
		}
		await this.ctx.storage.put<JobRecord>("job", {
			...record,
			state: "running",
		});
		let outcome: "delivered" | "pending";
		try {
			outcome = await runWithJobTimeLimit(record.job, () =>
				runBackgroundJob(this.env, record.job),
			);
		} catch (error) {
			if (error instanceof JobTimeLimitReached) {
				await this.givenUp(record);
				return;
			}
			// Messages can carry provider or SQL diagnostics; log the class only.
			await this.finish(
				record,
				"failed",
				`error:${error instanceof Error ? error.name : "unknown"}`,
			);
			return;
		} finally {
			release();
		}
		if (outcome === "delivered") {
			await this.finish(record, "done");
			return;
		}
		const attempts = record.attempts + 1;
		if (peerDeadlineReached(attempts, record.job.kind)) {
			await this.finish(record, "failed", "peer delivery deadline exceeded");
			return;
		}
		await this.ctx.storage.put<JobRecord>("job", {
			...record,
			state: "queued",
			attempts,
		});
		await this.ctx.storage.setAlarm(
			Date.now() + retryDelayMs(record.job.kind, record.attempts),
		);
	}

	/**
	 * A run that outlived its time limit is treated like an interrupted one: a
	 * job safe to repeat runs again (a few times at most); any other fails,
	 * since what it did before hanging is unknown.
	 */
	private async givenUp(record: JobRecord) {
		const interruptions = (record.interruptions ?? 0) + 1;
		if (interruptedJobDecision(record.job.kind, interruptions - 1) === "fail") {
			await this.finish(record, "failed", "time limit");
			return;
		}
		await this.ctx.storage.put<JobRecord>("job", {
			...record,
			interruptions,
			state: "queued",
		});
		await this.ctx.storage.setAlarm(Date.now() + deferralDelayMs());
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
