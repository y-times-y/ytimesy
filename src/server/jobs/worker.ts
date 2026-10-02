import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import type { EnvironmentModel } from "#/domain/environment-model";
import {
	markCompetitionStatus,
	reconcileFinishedCompetitionJudges,
} from "../adapters/agent-competitions";
import { claimApiTurn, expireApiTurnLeases } from "../adapters/api-turns";
import { sessionsAwaitingCheckpoint } from "../adapters/checkpoints/records";
import { closeDatabase } from "../adapters/database";
import { readFreestyleApiKey } from "../adapters/freestyle/api-key";
import { createFreestyleWorkspaceMachines } from "../adapters/freestyle/workspace-machines";
import { applyProjectEnvironment } from "../adapters/rigkit/apply";
import { listReadyWorkspaceIds } from "../adapters/workspaces";
import { startAgentCompetition } from "../services/agent-competition-run";
import {
	deliverAgentPeerMessage,
	type PeerMessage,
} from "../services/agent-peer-messaging";
import { deliverAgentTaskEvents } from "../services/agent-task-event-delivery";
import { reconcileRunningAgentTurns } from "../services/agent-turn-reconciliation";
import { captureSessionCheckpoint } from "../services/session-checkpoint";
import { runApiTurn } from "./api-turn";
import {
	AGENT_PEER_MESSAGE_QUEUE,
	AGENT_TASK_EVENT_QUEUE,
	jobQueue,
	PREPARE_WORKSPACE_QUEUE,
	REFRESH_WORKSPACE_QUEUE,
	SESSION_CHECKPOINT_QUEUE,
	START_COMPETITION_QUEUE,
} from "./queue";

let turnSweep: ReturnType<typeof setInterval> | undefined;
let apiTurnSweep: ReturnType<typeof setInterval> | undefined;

export async function startWorkspaceWorker() {
	const queue = await jobQueue("worker");
	const taskMachines = createFreestyleWorkspaceMachines(
		await Effect.runPromise(readFreestyleApiKey()),
	);
	await queue.work<PeerMessage>(
		AGENT_PEER_MESSAGE_QUEUE,
		{ localConcurrency: 1 },
		async ([job]) => {
			await deliverAgentPeerMessage(taskMachines, job.data, job.id);
		},
	);
	await queue.work<{ userId?: string; sessionId?: string }>(
		SESSION_CHECKPOINT_QUEUE,
		{ localConcurrency: 1 },
		async ([job]) => {
			if (!process.env.SUPABASE_STORAGE_SERVICE_KEY) return;
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
	if (process.env.SUPABASE_STORAGE_SERVICE_KEY)
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
		);
	});
	await queue.work<{ workspaceId?: string }>(
		REFRESH_WORKSPACE_QUEUE,
		{ localConcurrency: 1 },
		async ([job]) => {
			if (process.env.YTIMESY_ENVIRONMENT_AUTO_REFRESH === "false") return;
			if (job.data.workspaceId) {
				await applyProjectEnvironment(job.data.workspaceId);
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
		{ localConcurrency: 4 },
		async ([job]) => {
			await deliverAgentTaskEvents(taskMachines, job.data.eventId ?? undefined);
		},
	);
	await queue.work<{ rootSessionId: string }>(
		START_COMPETITION_QUEUE,
		{ localConcurrency: 1 },
		async ([job]) => {
			try {
				await startAgentCompetition(taskMachines, job.data.rootSessionId);
			} catch {
				await markCompetitionStatus(
					job.data.rootSessionId,
					"failed",
					"Could not launch all independent agents. Review the Tasks panel for any partial work.",
				);
			}
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
	const reconcile = async () => {
		if (reconciling) return;
		reconciling = true;
		try {
			await reconcileRunningAgentTurns(taskMachines);
			await reconcileFinishedCompetitionJudges();
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
	let apiClaiming = false;
	let apiRunning = 0;
	const runPendingApiTurn = async () => {
		if (apiClaiming || apiRunning >= 2) return;
		apiClaiming = true;
		try {
			await expireApiTurnLeases();
			const turn = await claimApiTurn();
			if (turn) {
				apiRunning++;
				void runApiTurn(taskMachines, turn)
					.catch(() => {})
					.finally(() => {
						apiRunning--;
					});
			}
		} catch {
			/* A later sweep retries database outages; running turns are never replayed. */
		} finally {
			apiClaiming = false;
		}
	};
	if (apiTurnSweep) clearInterval(apiTurnSweep);
	apiTurnSweep = setInterval(() => void runPendingApiTurn(), 1000);
	apiTurnSweep.unref();
	return queue;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	const queue = await startWorkspaceWorker();
	console.info("ytimesy workspace worker is running.");
	const stop = async () => {
		if (turnSweep) clearInterval(turnSweep);
		if (apiTurnSweep) clearInterval(apiTurnSweep);
		await queue.stop({ graceful: true, timeout: 15000 });
		await closeDatabase();
		process.exit(0);
	};
	process.on("SIGINT", () => void stop());
	process.on("SIGTERM", () => void stop());
}
