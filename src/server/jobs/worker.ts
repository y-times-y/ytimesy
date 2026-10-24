import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import { Freestyle } from "freestyle";
import type { EnvironmentModel } from "#/domain/environment-model";
import { configuredTurnExecutor } from "#/domain/turn-executor";
import { modelConcurrencyLimits } from "../adapters/agent-capacity";
import { claimApiTurn, expireApiTurnLeases } from "../adapters/api-turns";
import { sessionsAwaitingCheckpoint } from "../adapters/checkpoints/records";
import { checkpointStorageConfigured } from "../adapters/checkpoints/storage";
import { closeDatabase } from "../adapters/database";
import { readFreestyleApiKey } from "../adapters/freestyle/api-key";
import { boundedFreestyleFetch } from "../adapters/freestyle/bounded-fetch";
import { observeFleetCosts } from "../adapters/freestyle/fleet-costs";
import { reconcileInfrastructureVms } from "../adapters/freestyle/usage-admission";
import { createFreestyleWorkspaceMachines } from "../adapters/freestyle/workspace-machines";
import { recycleIdleWorkspaces } from "../adapters/freestyle/workspace-retention";
import { applyProjectEnvironment } from "../adapters/rigkit/apply";
import { listenForQueuedTurns } from "../adapters/turn-queue-wake";
import { listReadyWorkspaceIds } from "../adapters/workspaces";
import {
	deliverAgentPeerMessage,
	type PeerMessage,
} from "../services/agent-peer-messaging";
import { deliverAgentTaskEvents } from "../services/agent-task-event-delivery";
import { wakeChatsForBackgroundCommands } from "../services/background-command-notices";
import { deliverPrRepairEvents } from "../services/pr-repair";
import { captureSessionCheckpoint } from "../services/session-checkpoint";
import { teardownSubagentForks } from "../services/subagent-runtime";
import { recoverChildTurnEvents } from "../services/subagent-turn-recovery";
import type { WorkspaceMachines } from "../services/workspace-machines";
import { runApiTurn } from "./api-turn";
import {
	drainConversationDeliveries,
	relayConversationDeliveries,
} from "./conversation-delivery";
import {
	AGENT_PEER_MESSAGE_QUEUE,
	AGENT_TASK_EVENT_QUEUE,
	jobQueue,
	PR_REPAIR_QUEUE,
	PREPARE_WORKSPACE_QUEUE,
	REFRESH_WORKSPACE_QUEUE,
	SESSION_CHECKPOINT_QUEUE,
} from "./queue";
import { TurnDispatcher } from "./turn-dispatcher";

let turnSweep: ReturnType<typeof setInterval> | undefined;
let apiTurnSweep: ReturnType<typeof setInterval> | undefined;
let deliverySweep: ReturnType<typeof setInterval> | undefined;
let infrastructureSweep: ReturnType<typeof setInterval> | undefined;
let stopTurnWake: (() => Promise<void>) | undefined;
let dispatcher:
	| TurnDispatcher<NonNullable<Awaited<ReturnType<typeof claimApiTurn>>>>
	| undefined;

/**
 * Local in-process runner for harness evaluation against an isolated database.
 * Application environments execute on Cloudflare; this must never share their queue.
 */
export async function startWorkspaceWorker(machines?: WorkspaceMachines) {
	if (
		process.env.YTIMESY_BACKGROUND_WORKFLOW_URL ||
		configuredTurnExecutor(process.env.YTIMESY_MODEL_EXECUTION_TARGET) !==
			"node"
	)
		throw new Error(
			"The local runner cannot start while Cloudflare execution is configured.",
		);
	const queue = await jobQueue("worker");
	const taskMachines =
		machines ??
		createFreestyleWorkspaceMachines(
			await Effect.runPromise(readFreestyleApiKey()),
		);
	await queue.work<PeerMessage>(
		AGENT_PEER_MESSAGE_QUEUE,
		{ localConcurrency: 1 },
		async ([job]) => {
			await deliverAgentPeerMessage(taskMachines, job.data, job.id);
		},
	);
	await queue.work(
		PR_REPAIR_QUEUE,
		{ localConcurrency: 1, pollingIntervalSeconds: 1 },
		async () => {
			await deliverPrRepairEvents(taskMachines);
		},
	);
	await queue.work<{ userId?: string; sessionId?: string }>(
		SESSION_CHECKPOINT_QUEUE,
		{ localConcurrency: 1 },
		async ([job]) => {
			if (!checkpointStorageConfigured()) return;
			if (!job.data.userId || !job.data.sessionId) {
				for (const session of await sessionsAwaitingCheckpoint())
					await queue.send(
						SESSION_CHECKPOINT_QUEUE,
						{ userId: session.user_id, sessionId: session.id },
						{ singletonKey: session.id },
					);
				return;
			}
			await captureSessionCheckpoint(
				taskMachines,
				job.data.userId,
				job.data.sessionId,
			);
		},
	);
	if (checkpointStorageConfigured())
		await queue.schedule(
			SESSION_CHECKPOINT_QUEUE,
			"* * * * *",
			{},
			{ singletonKey: "checkpoint-sweep" },
		);
	await queue.work<{
		workspaceId: string;
		repairModel?: EnvironmentModel | null;
	}>(PREPARE_WORKSPACE_QUEUE, { localConcurrency: 2 }, async ([job]) => {
		await applyProjectEnvironment(
			job.data.workspaceId,
			true,
			job.data.repairModel ?? null,
			job.id,
		);
	});
	await queue.work<{ workspaceId?: string }>(
		REFRESH_WORKSPACE_QUEUE,
		{ localConcurrency: 1 },
		async ([job]) => {
			if (process.env.YTIMESY_ENVIRONMENT_AUTO_REFRESH === "false") return;
			if (job.data.workspaceId) {
				await applyProjectEnvironment(
					job.data.workspaceId,
					false,
					null,
					job.id,
				);
				return;
			}
			for (const workspaceId of await listReadyWorkspaceIds()) {
				await queue.send(
					REFRESH_WORKSPACE_QUEUE,
					{ workspaceId },
					{ singletonKey: `refresh:${workspaceId}` },
				);
			}
		},
	);
	await queue.work<{ eventId?: string | null }>(
		AGENT_TASK_EVENT_QUEUE,
		{ localConcurrency: 4, pollingIntervalSeconds: 1 },
		async ([job]) => {
			await deliverAgentTaskEvents(taskMachines, job.data.eventId ?? undefined);
		},
	);
	try {
		if (process.env.YTIMESY_ENVIRONMENT_AUTO_REFRESH === "false")
			await queue.unschedule(REFRESH_WORKSPACE_QUEUE);
		else await queue.schedule(REFRESH_WORKSPACE_QUEUE, "0 * * * *", {});
	} catch {
		// Hourly check is already registered for this queue.
	}
	try {
		await queue.schedule(AGENT_TASK_EVENT_QUEUE, "* * * * *", {});
	} catch {
		// The durable sweep is already registered.
	}
	let reconciling = false;
	let supervisingAt = 0;
	const reconcile = async () => {
		if (reconciling) return;
		reconciling = true;
		try {
			await deliverAgentTaskEvents(taskMachines);
			if (Date.now() - supervisingAt >= 30_000) {
				supervisingAt = Date.now();
				await recoverChildTurnEvents(taskMachines);
				// Background commands that exited while their chat was between turns.
				await wakeChatsForBackgroundCommands(taskMachines);
				await teardownSubagentForks(taskMachines);
				await deliverPrRepairEvents(taskMachines);
			}
		} catch {
			// The next sweep retries after a database or provider outage.
		} finally {
			reconciling = false;
		}
	};
	if (turnSweep) clearInterval(turnSweep);
	turnSweep = setInterval(() => void reconcile(), 2_000);
	turnSweep.unref();
	void reconcile();
	const { worker: concurrency, perUser, fleet } = modelConcurrencyLimits();
	dispatcher = new TurnDispatcher({
		concurrency,
		claim: () => claimApiTurn(perUser, fleet, "node"),
		run: async (turn) => {
			await runApiTurn(taskMachines, turn);
		},
		onError: () =>
			console.warn(
				"Model dispatch failed; the durable queue will be checked again.",
			),
	});
	await stopTurnWake?.();
	stopTurnWake = listenForQueuedTurns(() => dispatcher?.wake());
	if (apiTurnSweep) clearInterval(apiTurnSweep);
	apiTurnSweep = setInterval(() => {
		dispatcher?.wake();
		void expireApiTurnLeases().catch(() => {});
	}, 1000);
	apiTurnSweep.unref();
	dispatcher.wake();
	let relaying = false;
	if (deliverySweep) clearInterval(deliverySweep);
	deliverySweep = setInterval(() => {
		if (relaying) return;
		relaying = true;
		void relayConversationDeliveries()
			.catch(() => {})
			.finally(() => {
				relaying = false;
			});
	}, 250);
	deliverySweep.unref();
	// Injected operator adapters own resource reconciliation themselves. Never
	// reconcile the shared provider fleet while consuming an isolated job queue.
	if (machines) return queue;
	const infrastructureClient = new Freestyle({
		apiKey: await Effect.runPromise(readFreestyleApiKey()),
		fetch: boundedFreestyleFetch(),
	});
	let reconcilingUsage = false;
	let fleetObservedAt = 0;
	if (infrastructureSweep) clearInterval(infrastructureSweep);
	infrastructureSweep = setInterval(() => {
		if (reconcilingUsage) return;
		reconcilingUsage = true;
		void reconcileInfrastructureVms(infrastructureClient)
			.then(async () => {
				if (Date.now() - fleetObservedAt >= 300_000) {
					await observeFleetCosts(infrastructureClient);
					fleetObservedAt = Date.now();
				}
				await recycleIdleWorkspaces(infrastructureClient);
			})
			.catch(() => {
				console.warn("Infrastructure reconciliation deferred.");
			})
			.finally(() => {
				reconcilingUsage = false;
			});
	}, 60_000);
	infrastructureSweep.unref();
	return queue;
}

export async function runWorkspaceWorker(machines?: WorkspaceMachines) {
	const queue = await startWorkspaceWorker(machines);
	console.info("ytimesy local runner is running.");
	let stopping = false;
	const stop = async () => {
		if (stopping) return;
		stopping = true;
		await stopWorkspaceWorker(queue);
		await closeDatabase();
		process.exit(0);
	};
	process.on("SIGINT", () => void stop());
	process.on("SIGTERM", () => void stop());
}

/** Operator embeddings and the CLI share the same drain path. */
export async function stopWorkspaceWorker(
	queue: Awaited<ReturnType<typeof startWorkspaceWorker>>,
) {
	if (turnSweep) clearInterval(turnSweep);
	if (apiTurnSweep) clearInterval(apiTurnSweep);
	if (infrastructureSweep) clearInterval(infrastructureSweep);
	const drain = dispatcher?.drain();
	await stopTurnWake?.();
	await drain;
	if (deliverySweep) clearInterval(deliverySweep);
	await relayConversationDeliveries().catch(() => {});
	await drainConversationDeliveries();
	await queue.stop({ graceful: true, timeout: 15000 });
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	await runWorkspaceWorker();
}
