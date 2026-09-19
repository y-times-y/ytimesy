import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { workspaceRuntimeFromEnv } from "../adapters/freestyle/workspace-runtime";
import { runWorkspacePreparation } from "./prepare-workspace";
import {
	jobQueue,
	PREPARE_WORKSPACE_QUEUE,
	REFRESH_WORKSPACE_QUEUE,
} from "./queue";
import {
	readyWorkspaceIdsToRefresh,
	refreshWorkspaceSnapshot,
} from "./refresh-workspace";

const runtime = workspaceRuntimeFromEnv();

export async function startWorkspaceWorker() {
	const queue = await jobQueue();
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
	try {
		await queue.schedule(REFRESH_WORKSPACE_QUEUE, "0 * * * *", {});
	} catch {
		// Hourly check is already registered for this queue.
	}
	return queue;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	const queue = await startWorkspaceWorker();
	console.info("ytimesy workspace worker is running.");
	const stop = async () => {
		await queue.stop({ graceful: true, timeout: 15000 });
		process.exit(0);
	};
	process.on("SIGINT", () => void stop());
	process.on("SIGTERM", () => void stop());
}
