import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import type { EnvironmentModel } from "#/domain/environment-model";
import { claimApiTurn, expireApiTurnLeases } from "../adapters/api-turns";
import { closeDatabase } from "../adapters/database";
import { readFreestyleApiKey } from "../adapters/freestyle/api-key";
import { createFreestyleWorkspaceMachines } from "../adapters/freestyle/workspace-machines";
import { applyProjectEnvironment } from "../adapters/rigkit/apply";
import { listReadyWorkspaceIds } from "../adapters/workspaces";
import { deliverAgentTaskEvents } from "../services/agent-task-event-delivery";
import { reconcileRunningAgentTurns } from "../services/agent-turn-reconciliation";
import { reconcileCodexRefreshRequests } from "../services/codex-refresh-reconciliation";
import { runApiTurn } from "./api-turn";
import {
	AGENT_TASK_EVENT_QUEUE,
	jobQueue,
	PREPARE_WORKSPACE_QUEUE,
	REFRESH_WORKSPACE_QUEUE,
} from "./queue";

let turnSweep: ReturnType<typeof setInterval> | undefined;
let codexRefreshSweep: ReturnType<typeof setInterval> | undefined;
let apiTurnSweep: ReturnType<typeof setInterval> | undefined;

export async function startWorkspaceWorker() {
	const queue = await jobQueue("worker");
	const taskMachines = createFreestyleWorkspaceMachines(
		await Effect.runPromise(readFreestyleApiKey()),
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
	let refreshingCodex = false;
	const refreshCodex = async () => {
		if (refreshingCodex) return;
		refreshingCodex = true;
		try {
			await reconcileCodexRefreshRequests(taskMachines);
		} catch {
			// A later sweep retries transient database and provider failures.
		} finally {
			refreshingCodex = false;
		}
	};
	if (codexRefreshSweep) clearInterval(codexRefreshSweep);
	codexRefreshSweep = setInterval(() => void refreshCodex(), 1_000);
	codexRefreshSweep.unref();
	void refreshCodex();
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
		if (codexRefreshSweep) clearInterval(codexRefreshSweep);
		await queue.stop({ graceful: true, timeout: 15000 });
		await closeDatabase();
		process.exit(0);
	};
	process.on("SIGINT", () => void stop());
	process.on("SIGTERM", () => void stop());
}
