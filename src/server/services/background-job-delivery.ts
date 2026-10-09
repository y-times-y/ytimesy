import { Effect } from "effect";
import { Freestyle } from "freestyle";
import type { BackgroundJob } from "#/domain/background-job";
import { reconcileFinishedCompetitionJudges } from "../adapters/agent-competitions";
import { recoverInterruptedTaskIntegrations } from "../adapters/agent-task-events";
import { expireApiTurnLeases } from "../adapters/api-turns";
import {
	backgroundJobId,
	dispatchBackgroundJob,
} from "../adapters/background-job-dispatch";
import { sessionsAwaitingCheckpoint } from "../adapters/checkpoints/records";
import { readFreestyleApiKey } from "../adapters/freestyle/api-key";
import { observeFleetCosts } from "../adapters/freestyle/fleet-costs";
import { reconcileInfrastructureVms } from "../adapters/freestyle/usage-admission";
import { recycleIdleWorkspaces } from "../adapters/freestyle/workspace-retention";
import { listReadyWorkspaceIds } from "../adapters/workspaces";
import { relayConversationDeliveriesOnce } from "../jobs/conversation-delivery";
import { enqueueSessionCheckpoint } from "../jobs/queue";
import {
	recoverChildTurnEvents,
	superviseAgentChildren,
} from "./agent-child-supervision";
import { startAgentCompetition } from "./agent-competition-run";
import {
	deliverAgentPeerMessage,
	PeerMessagePendingError,
} from "./agent-peer-messaging";
import { deliverAgentTaskEvents } from "./agent-task-event-delivery";
import { reconcileRunningAgentTurns } from "./agent-turn-reconciliation";
import { dispatchDurableWork } from "./durable-work-plan";
import { recoverExpiredEnvironmentBuilds } from "./environment-build";
import { deliverPrRepairEvents } from "./pr-repair";
import { captureSessionCheckpoint } from "./session-checkpoint";
import type { WorkspaceMachines } from "./workspace-machines";

export async function deliverBackgroundJob(
	machines: WorkspaceMachines,
	job: Exclude<BackgroundJob, { kind: "prepare" | "model-admission" }>,
): Promise<"delivered" | "pending"> {
	switch (job.kind) {
		case "maintenance":
			switch (job.action) {
				case "reconcile":
					await recoverExpiredEnvironmentBuilds();
					await expireApiTurnLeases();
					await reconcileRunningAgentTurns(machines);
					await reconcileFinishedCompetitionJudges();
					break;
				case "supervise":
					await recoverChildTurnEvents();
					await recoverInterruptedTaskIntegrations();
					await superviseAgentChildren(machines);
					break;
				case "delivery":
					await relayConversationDeliveriesOnce();
					break;
				case "checkpoints":
					if (process.env.SUPABASE_STORAGE_SERVICE_KEY)
						for (const session of await sessionsAwaitingCheckpoint())
							await enqueueSessionCheckpoint(session.user_id, session.id);
					break;
				case "refresh":
					if (process.env.YTIMESY_ENVIRONMENT_AUTO_REFRESH !== "false")
						for (const workspaceId of await listReadyWorkspaceIds())
							await dispatchBackgroundJob({
								id: backgroundJobId(`${job.id}:${workspaceId}`),
								kind: "prepare",
								workspaceId,
								force: false,
								repairModel: null,
							});
					break;
				case "infrastructure": {
					const client = new Freestyle({
						apiKey: Effect.runSync(readFreestyleApiKey()),
					});
					await reconcileInfrastructureVms(client);
					await observeFleetCosts(client);
					await recycleIdleWorkspaces(client);
					break;
				}
			}
			break;
		case "task-event":
			await deliverAgentTaskEvents(machines, job.eventId ?? undefined);
			break;
		case "peer-message":
			try {
				await deliverAgentPeerMessage(machines, job, job.id);
			} catch (error) {
				if (error instanceof PeerMessagePendingError) return "pending";
				throw error;
			}
			break;
		case "competition":
			await startAgentCompetition(machines, job.rootSessionId);
			break;
		case "checkpoint":
			await captureSessionCheckpoint(machines, job.userId, job.sessionId);
			break;
		case "pr-repair":
			await deliverPrRepairEvents(machines);
			break;
		case "work-plan":
			await dispatchDurableWork(machines);
			break;
	}
	return "delivered";
}
