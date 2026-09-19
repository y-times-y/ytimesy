import { PgBoss } from "pg-boss";
import { serverConfig } from "../config";

export const PREPARE_WORKSPACE_QUEUE = "prepare-workspace";
export const REFRESH_WORKSPACE_QUEUE = "refresh-workspace-snapshot";

export interface WorkspaceJobQueue {
	enqueuePrepare(workspaceId: string): Promise<string | null>;
	enqueueRefresh?(workspaceId: string): Promise<string | null>;
}

let boss: PgBoss | undefined;

export async function jobQueue(): Promise<PgBoss> {
	if (!boss) {
		boss = new PgBoss({
			connectionString: serverConfig().DATABASE_URL,
			schema: "job_queue",
			max: 2,
			application_name: "ytimesy-jobs",
		});
		await boss.start();
		await boss.createQueue(PREPARE_WORKSPACE_QUEUE, {
			policy: "singleton",
			retryLimit: 3,
			retryBackoff: true,
			retryDelay: 30,
			expireInSeconds: 30 * 60,
		});
		await boss.createQueue(REFRESH_WORKSPACE_QUEUE, {
			policy: "singleton",
			retryLimit: 1,
			expireInSeconds: 30 * 60,
		});
	}
	return boss;
}

export const postgresJobQueue: WorkspaceJobQueue = {
	async enqueuePrepare(workspaceId) {
		const queue = await jobQueue();
		return queue.send(
			PREPARE_WORKSPACE_QUEUE,
			{ workspaceId },
			{ singletonKey: workspaceId },
		);
	},
	async enqueueRefresh(workspaceId) {
		const queue = await jobQueue();
		return queue.send(
			REFRESH_WORKSPACE_QUEUE,
			{ workspaceId },
			{ singletonKey: `refresh:${workspaceId}` },
		);
	},
};

export function closeJobQueueForTests() {
	const closing = boss?.stop({ graceful: false, timeout: 1000 });
	boss = undefined;
	return closing;
}
