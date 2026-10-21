import { deliverPullRequestWakes } from "./pull-request-wake";
import type { WorkspaceMachines } from "./workspace-machines";

/**
 * Chat wake-ups for pull requests ytimesy opened
 * (src/server/services/pull-request-wake.ts); run from the pr-repair job.
 */
export async function deliverPrRepairEvents(machines: WorkspaceMachines) {
	if (process.env.YTIMESY_PR_REPAIR_ENABLED !== "1") return;
	await deliverPullRequestWakes(machines);
}
