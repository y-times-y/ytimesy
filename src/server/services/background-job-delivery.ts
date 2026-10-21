import { Effect } from "effect";
import { Freestyle } from "freestyle";
import type { BackgroundJob } from "#/domain/background-job";
import { expireApiTurnLeases } from "../adapters/api-turns";
import {
	backgroundJobId,
	dispatchBackgroundJob,
} from "../adapters/background-job-dispatch";
import { sessionsAwaitingCheckpoint } from "../adapters/checkpoints/records";
import { checkpointStorageConfigured } from "../adapters/checkpoints/storage";
import {
	authEmailDeliveryConfigured,
	deliverAuthEmails,
} from "../adapters/email";
import { readFreestyleApiKey } from "../adapters/freestyle/api-key";
import { observeFleetCosts } from "../adapters/freestyle/fleet-costs";
import { reconcileInfrastructureVms } from "../adapters/freestyle/usage-admission";
import { recycleIdleWorkspaces } from "../adapters/freestyle/workspace-retention";
import { memoryReposAvailable } from "../adapters/memory-repos";
import { memoryDreamCandidates } from "../adapters/memory-settings";
import { listReadyWorkspaceIds } from "../adapters/workspaces";
import { relayConversationDeliveriesOnce } from "../jobs/conversation-delivery";
import { enqueueSessionCheckpoint } from "../jobs/queue";
import {
	deliverAgentPeerMessage,
	PeerMessagePendingError,
} from "./agent-peer-messaging";
import { deliverAgentTaskEvents } from "./agent-task-event-delivery";
import { recoverExpiredEnvironmentBuilds } from "./environment-build";
import {
	DREAM_IDLE_SECONDS,
	runMemoryDream,
	runMemorySave,
} from "./memory-jobs";
import {
	alertAbandonedTurns,
	alertFailedEmails,
	alertFleetBudget,
} from "./operational-alerts";
import { expirePullRequestEvidence } from "./pr-evidence-cleanup";
import { runPullRequestEvidenceJob } from "./pr-evidence-job";
import { deliverPrRepairEvents } from "./pr-repair";
import { captureSessionCheckpoint } from "./session-checkpoint";
import { recoverStaleQueuedWorkspaces } from "./stale-workspace-queue";
import { teardownSubagentForks } from "./subagent-runtime";
import { recoverChildTurnEvents } from "./subagent-turn-recovery";
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
					await recoverStaleQueuedWorkspaces();
					await alertAbandonedTurns(await expireApiTurnLeases());
					break;
				case "supervise":
					await recoverChildTurnEvents(machines);
					// Writer subagents' forks, 30 minutes after their report.
					await teardownSubagentForks(machines);
					break;
				case "delivery":
					await relayConversationDeliveriesOnce();
					// Verification and password-reset mail queued by the web app.
					if (authEmailDeliveryConfigured())
						await alertFailedEmails((await deliverAuthEmails()).failed);
					break;
				case "checkpoints":
					if (checkpointStorageConfigured())
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
					await alertFleetBudget();
					break;
				}
				case "memory-dreams":
					// One dream per idle user and per point of new activity.
					if (memoryReposAvailable())
						for (const candidate of await memoryDreamCandidates(
							DREAM_IDLE_SECONDS,
						))
							await dispatchBackgroundJob({
								id: backgroundJobId(
									`memory-dream:${candidate.user_id}:${candidate.last_at.toISOString()}`,
								),
								kind: "memory",
								action: "dream",
								userId: candidate.user_id,
							});
					break;
				case "evidence-expiry":
					// Pull request evidence past retention or of closed pull requests.
					await expirePullRequestEvidence();
					break;
			}
			break;
		case "memory": {
			const outcome =
				job.action === "dream"
					? await runMemoryDream(job.userId)
					: job.sessionId
						? await runMemorySave(job.userId, job.sessionId)
						: "missing-session";
			if (
				![
					"committed",
					"unchanged",
					"idle",
					"saved",
					"skipped",
					"nothing-new",
					"off",
				].includes(outcome)
			)
				console.warn("Memory job ended without saving.", {
					action: job.action,
					outcome,
				});
			break;
		}
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
		case "checkpoint":
			await captureSessionCheckpoint(machines, job.userId, job.sessionId);
			break;
		case "pr-repair":
			await deliverPrRepairEvents(machines);
			break;
		case "pr-evidence": {
			const outcome = await runPullRequestEvidenceJob(machines, job);
			if (outcome.kind === "updated" && outcome.status !== "captured")
				console.warn("Pull request evidence was not captured.", {
					status: outcome.status,
				});
			break;
		}
	}
	return "delivered";
}
