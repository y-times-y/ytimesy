import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import { z } from "zod";
import {
	type EnvironmentWorkflowRequest,
	environmentWorkflowRequest,
} from "../../domain/environment-workflow";
import { withCodexSubscriptionEgress } from "../adapters/codex-subscription-transport";
import { withDatabaseScope } from "../adapters/database-scope";
import { environmentFreestyleFetch } from "../adapters/freestyle/environment-fetch";
import { workspaceRuntimeFromEnv } from "../adapters/freestyle/workspace-runtime";
import {
	activateEnvironmentBuild,
	assertDistinctEnvironmentServicePorts,
	claimEnvironmentBuild,
	failEnvironmentPreflight,
	finishEnvironmentBuild,
	type PreparedRepository,
	prepareEnvironmentRepositories,
	provisionEnvironmentBuild,
	resolveEnvironmentBuildInput,
	verifyEnvironmentRepositories,
} from "../services/environment-build";
import type { EdgeExecutorEnvironment } from "./environment";

const configuration = z.object({
	DATABASE_URL: z.string().min(1),
	DATABASE_SSL_CA: z.string().optional(),
	YTIMESY_GIT_PROXY_URL: z.url(),
	YTIMESY_GIT_PROXY_SECRET: z.string().min(32),
});

/** The existing preparation recipe runs directly in durable steps, not a Bun subprocess. */
export class ProjectEnvironmentWorkflow extends WorkflowEntrypoint<
	EdgeExecutorEnvironment,
	EnvironmentWorkflowRequest
> {
	async run(
		event: WorkflowEvent<EnvironmentWorkflowRequest>,
		step: WorkflowStep,
	) {
		configuration.parse(this.env);
		const request = environmentWorkflowRequest.parse(event.payload);
		const counts = { requests: 0, backgroundPolls: 0 };
		const runtime = workspaceRuntimeFromEnv(process.env, {
			fetch: environmentFreestyleFetch(counts),
			streamSetupCommands: true,
		});
		const recorded = <T extends Rpc.Serializable<T>>(
			name: string,
			run: () => Promise<T>,
			cleanup = false,
		) =>
			step.do(
				name,
				{
					retries: {
						limit: cleanup ? 3 : 0,
						delay: "5 seconds",
						backoff: "exponential",
					},
					timeout: cleanup ? "5 minutes" : "65 minutes",
				},
				async () => {
					const before = { ...counts };
					try {
						return await withDatabaseScope(
							this.env.HYPERDRIVE.connectionString,
							() =>
								withCodexSubscriptionEgress(
									(input, options) =>
										this.env.CODEX_EGRESS.fetch(input, options),
									run,
								),
							null,
						);
					} finally {
						console.info("environment-provider-requests", {
							stage: name,
							requests: counts.requests - before.requests,
							backgroundPolls: counts.backgroundPolls - before.backgroundPolls,
						});
					}
				},
			);
		const input = await recorded("resolve-authorized-sources", async () => {
			try {
				return await resolveEnvironmentBuildInput(
					request.workspaceId,
					request.force,
					runtime,
					request.repairModel,
				);
			} catch {
				await failEnvironmentPreflight(request.workspaceId);
				throw new Error("Environment source authorization failed.");
			}
		});
		if (!input) return { outcome: "unchanged" };
		const buildId = await recorded("claim-build", () =>
			claimEnvironmentBuild(input, runtime),
		);
		try {
			const vm = await recorded("provision", () =>
				provisionEnvironmentBuild(input, buildId, runtime),
			);
			const repositories: PreparedRepository[] = [];
			for (const [index, repository] of input.repositories.entries()) {
				const prepared = await recorded(`checkout-and-install-${index}`, () =>
					prepareEnvironmentRepositories(
						{ ...input, repositories: [repository] },
						vm,
						runtime,
					),
				);
				repositories.push(...prepared);
			}
			assertDistinctEnvironmentServicePorts(repositories);
			const verified = await recorded("verify", () =>
				verifyEnvironmentRepositories(input, vm, repositories, runtime),
			);
			const snapshotId = await recorded("activate-snapshot", () =>
				activateEnvironmentBuild(input, buildId, vm, verified, runtime),
			);
			return { outcome: "ready", snapshotId };
		} finally {
			await recorded(
				"finish-and-pause",
				() =>
					finishEnvironmentBuild(input, buildId, runtime).then(() => ({
						cleaned: true,
					})),
				true,
			);
		}
	}
}
