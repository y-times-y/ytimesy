import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import { closeDatabase } from "../adapters/database";
import { readFreestyleApiKey } from "../adapters/freestyle/api-key";
import { createFreestyleWorkspaceMachines } from "../adapters/freestyle/workspace-machines";
import { workspaceRuntimeFromEnv } from "../adapters/freestyle/workspace-runtime";
import { deliverAgentTaskEvents } from "../services/agent-task-event-delivery";
import { reconcileRunningAgentTurns } from "../services/agent-turn-reconciliation";
import { reconcileCodexRefreshRequests } from "../services/codex-refresh-reconciliation";
import { runWorkspacePreparation } from "./prepare-workspace";
import {
	AGENT_TASK_EVENT_QUEUE,
	jobQueue,
	PREPARE_WORKSPACE_QUEUE,
	REFRESH_WORKSPACE_QUEUE,
} from "./queue";
import {
	readyWorkspaceIdsToRefresh,
	refreshWorkspaceSnapshot,
} from "./refresh-workspace";

const runtime = workspaceRuntimeFromEnv();
let turnSweep: ReturnType<typeof setInterval> | undefined;
let codexRefreshSweep: ReturnType<typeof setInterval> | undefined;

export async function startWorkspaceWorker() {
	const queue = await jobQueue("worker");
	const taskMachines = createFreestyleWorkspaceMachines(
		await Effect.runPromise(readFreestyleApiKey()),
	);
	await queue.work<{ workspaceId: string }>(
		PREPARE_WORKSPACE_QUEUE,
		{ localConcurrency: 2 },
		async ([job]) => {
			await runWorkspacePreparation(job.data.workspaceId, runtime);
		},
	);
	await queue.work<{ workspaceId?: string }>(
		REFRESH_WORKSPACE_QUEUE,
		{ localConcurrency: 1 },
		async ([job]) => {
			if (job.data.workspaceId) {
				await refreshWorkspaceSnapshot(job.data.workspaceId, runtime);
				return;
			}
			for (const workspaceId of await readyWorkspaceIdsToRefresh()) {
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
		await queue.schedule(REFRESH_WORKSPACE_QUEUE, "0 * * * *", {});
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
		if (codexRefreshSweep) clearInterval(codexRefreshSweep);
		await queue.stop({ graceful: true, timeout: 15000 });
		await closeDatabase();
		process.exit(0);
	};
	process.on("SIGINT", () => void stop());
	process.on("SIGTERM", () => void stop());
}
