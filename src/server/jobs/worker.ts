import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { UnconfiguredWorkspaceRuntime } from "../adapters/workspace-runtime";
import { runWorkspacePreparation } from "./prepare-workspace";
import { jobQueue, PREPARE_WORKSPACE_QUEUE } from "./queue";

const runtime = new UnconfiguredWorkspaceRuntime();

export async function startWorkspaceWorker() {
	const queue = await jobQueue();
	await queue.work<{ workspaceId: string }>(
		PREPARE_WORKSPACE_QUEUE,
		{ localConcurrency: 2 },
		async ([job]) => {
			await runWorkspacePreparation(job.data.workspaceId, runtime);
		},
	);
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
