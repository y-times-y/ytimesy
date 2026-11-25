import { Effect } from "effect";
import { Freestyle } from "freestyle";
import type { BackgroundJob } from "#/domain/background-job";
import { claudeBoxToolsEnabled } from "#/domain/claude-box-tools";
import { boxTurnUsers } from "#/domain/turn-executor";
import { failAbandonedHelperDrafts } from "../adapters/agent-sessions";
import {
	clearTurnBoxToolIdentity,
	compactSettledTurns,
	expireApiTurnLeases,
	staleTurnBoxToolIdentities,
} from "../adapters/api-turns";
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
import { boundedFreestyleFetch } from "../adapters/freestyle/bounded-fetch";
import { observeFleetCosts } from "../adapters/freestyle/fleet-costs";
import { releaseReplacedTemplateSnapshots } from "../adapters/freestyle/template-snapshot-release";
import { reconcileInfrastructureVms } from "../adapters/freestyle/usage-admission";
import { settleRetainedWorkspaces } from "../adapters/freestyle/workspace-retention";
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
import { purgeExpiredArchives, releaseArchivedMachines } from "./archive";
import {
	wakeChatForBackgroundCommands,
	wakeChatsForBackgroundCommands,
} from "./background-command-notices";
import { sweepClaudeBoxToolIdentities } from "./claude-box-tool-grant";
import { prepareForkWorkspace } from "./conversation-recovery";
import { recoverExpiredEnvironmentBuilds } from "./environment-build";
import { productionCanary } from "./interruption-canary";
import { runInterruptionMonitoring } from "./interruption-monitoring";
import { sweepUnusedChatMachines } from "./machine-prewarm";
import { runMaintenanceSteps } from "./maintenance-steps";
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
import {
	startProjectSetupAfterFirstBuild,
	startProjectSetupForWorkspace,
} from "./project-setup-background";
import {
	deliverHeldSends,
	dispatchReleasableHeldSends,
} from "./queued-user-messages";
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
					// Old turns' copies of the whole conversation (database size).
					await compactSettledTurns().catch((error: unknown) =>
						console.warn("Settled turns were not compacted.", {
							message:
								error instanceof Error ? error.message.slice(0, 200) : "",
						}),
					);
					break;
				case "supervise": {
					// Independent sweeps, side by side: a slow one never holds a
					// background command's wake-up behind it.
					const sweeps = await Promise.allSettled([
						recoverChildTurnEvents(machines),
						// Background commands that exited while their chat was between turns.
						wakeChatsForBackgroundCommands(machines),
						// Finished writers' forks, 10 minutes after their report (HELPER_FORK_RELEASE_MINUTES).
						teardownSubagentForks(machines),
						// New chats' machines copied ahead, when nothing was sent.
						sweepUnusedChatMachines(machines),
						// Messages held for setup whose environment is ready (a missed release).
						dispatchReleasableHeldSends(),
						// VM grants of Claude runner boxes whose turn no longer runs
						// (their tokens never expire; deleting the identity revokes them).
						// Helpers whose start failed before a turn was queued.
						failAbandonedHelperDrafts(),
						// Off with box tools off; bookkeeping never fails the job.
						claudeBoxToolsEnabled(process.env) ||
						boxTurnUsers(process.env.YTIMESY_BOX_TURN_USERS).size > 0
							? sweepClaudeBoxToolIdentities({
									machines,
									stale: () => staleTurnBoxToolIdentities(),
									clear: clearTurnBoxToolIdentity,
								}).catch((error: unknown) =>
									console.warn("Box tool identity sweep failed.", {
										message:
											error instanceof Error
												? error.message.slice(0, 200)
												: "unknown",
									}),
								)
							: Promise.resolve(),
					]);
					const failed = sweeps.find((sweep) => sweep.status === "rejected");
					if (failed) throw failed.reason;
					break;
				}
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
						fetch: boundedFreestyleFetch(),
					});
					// Independent steps: one failing never skips the others, and
					// only a failure that needs a human fails the job (and alerts).
					await runMaintenanceSteps("maintenance:infrastructure", [
						{
							name: "reconcile-vms",
							run: () => reconcileInfrastructureVms(client),
						},
						{ name: "fleet-costs", run: () => observeFleetCosts(client) },
						{
							name: "settle-retained-workspaces",
							run: () => settleRetainedWorkspaces(client),
						},
						{
							name: "release-replaced-templates",
							run: () => releaseReplacedTemplateSnapshots(client),
						},
						{ name: "fleet-budget", run: () => alertFleetBudget() },
						// Daily digest and the synthetic canary ride this tick
						// (docs/interruption-monitoring.md); never fails the job.
						{
							name: "interruption-monitoring",
							run: async () =>
								runInterruptionMonitoring(
									new Date(),
									await productionCanary(machines),
								),
						},
					]);
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
				case "archive-expiry":
					// Archived chats and projects past their 30 days; machines of
					// archived chats whose workspace is checkpointed.
					await releaseArchivedMachines(machines);
					await purgeExpiredArchives(machines);
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
		case "held-sends":
			// The workspace's environment just became ready. A first build's
			// project gets its setup chat if nothing started it when added; its
			// request then goes with the other held sends.
			await startProjectSetupAfterFirstBuild(machines, job.workspaceId).catch(
				(error: unknown) =>
					console.warn("The project's setup could not be started.", {
						message: error instanceof Error ? error.message.slice(0, 200) : "",
					}),
			);
			await deliverHeldSends(machines, job.workspaceId);
			break;
		case "project-setup":
			await startProjectSetupForWorkspace(machines, job.workspaceId);
			break;
		case "pr-repair":
			await deliverPrRepairEvents(machines);
			break;
		case "background-wake":
			// While the chat's turn runs, look again shortly (15 s, the job
			// runner's retry); the turn usually closes the card itself first.
			if (
				(await wakeChatForBackgroundCommands(machines, {
					userId: job.userId,
					id: job.sessionId,
					commandId: job.commandId,
				})) === "busy"
			)
				return "pending";
			break;
		case "conversation-fork":
			// A failure is kept on the fork's journal for its chat to show.
			await prepareForkWorkspace(
				machines,
				job.userId,
				job.sessionId,
				job.attempt,
			);
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
