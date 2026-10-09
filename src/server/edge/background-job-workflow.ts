import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import { Effect } from "effect";
import { type BackgroundJob, backgroundJob } from "../../domain/background-job";
import { modelConcurrencyLimits } from "../adapters/agent-capacity";
import { claimApiTurn } from "../adapters/api-turns";
import { withBackgroundJobDispatcher } from "../adapters/background-job-dispatch";
import { withDatabaseScope } from "../adapters/database-scope";
import { readFreestyleApiKey } from "../adapters/freestyle/api-key";
import { createFreestyleWorkspaceMachines } from "../adapters/freestyle/workspace-machines";
import { deliverBackgroundJob } from "../services/background-job-delivery";
import type { EdgeExecutorEnvironment } from "./environment";
import { withEdgeModelEndpoints } from "./model-endpoint";

/** Only an explicitly staged peer message is retried; uncertain side effects fail closed. */
export class BackgroundJobWorkflow extends WorkflowEntrypoint<
	EdgeExecutorEnvironment,
	BackgroundJob
> {
	async run(event: WorkflowEvent<BackgroundJob>, step: WorkflowStep) {
		const job = backgroundJob.parse(event.payload);
		for (let attempt = 0; attempt < 240; attempt++) {
			const outcome = await step.do(
				`deliver-${attempt}`,
				{ retries: { limit: 0, delay: "1 second" }, timeout: "30 minutes" },
				() =>
					withDatabaseScope(
						this.env.HYPERDRIVE.connectionString,
						() =>
							withBackgroundJobDispatcher(
								async (next) => {
									await this.env.BACKGROUND_JOBS.createBatch([
										{ id: next.id, params: next },
									]);
								},
								async () => {
									if (job.kind === "model-admission") {
										if (process.env.MODEL_EXECUTION_ENABLED !== "1")
											throw new Error("Model execution is disabled.");
										const limits = modelConcurrencyLimits();
										for (let count = 0; count < 16; count++) {
											const turn = await claimApiTurn(
												limits.perUser,
												limits.fleet,
												"durable-object",
											);
											if (!turn) break;
											if (!turn.lease_id)
												throw new Error("Claimed turn has no lease.");
											await this.env.MODEL_TURNS.createBatch([
												{
													id: `${turn.id}-${turn.lease_id}`,
													params: { turnId: turn.id, leaseId: turn.lease_id },
												},
											]);
										}
										return "delivered";
									}
									if (job.kind === "prepare") {
										if (this.env.ENVIRONMENT_EXECUTION_ENABLED !== "1")
											throw new Error("Environment execution is disabled.");
										await this.env.PROJECT_ENVIRONMENTS.createBatch([
											{
												id: job.id,
												params: {
													requestId: job.id,
													workspaceId: job.workspaceId,
													force: job.force,
													repairModel: job.repairModel,
												},
											},
										]);
										return "delivered";
									}
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
					),
			);
			if (outcome === "delivered") return { outcome };
			await step.sleep(`await-peer-${attempt}`, "15 seconds");
		}
		throw new Error(
			"Peer delivery deadline exceeded; inspect the recipient before resending.",
		);
	}
}
