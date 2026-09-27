import { PgBoss } from "pg-boss";
import { database } from "../adapters/database";

export const PREPARE_WORKSPACE_QUEUE = "prepare-workspace";
export const REFRESH_WORKSPACE_QUEUE = "refresh-workspace-snapshot";
export const AGENT_TASK_EVENT_QUEUE = "agent-task-event";

export interface WorkspaceJobQueue {
	enqueuePrepare(workspaceId: string): Promise<string | null>;
	enqueueRefresh?(workspaceId: string): Promise<string | null>;
}

type QueueRole = "producer" | "worker";
const processQueues = globalThis as typeof globalThis & {
	ytimesyJobQueues?: Partial<Record<QueueRole, Promise<PgBoss>>>;
};

/** Share startup across callers and hot reloads; jobs use the application's bounded pool. */
export function jobQueue(role: QueueRole = "producer"): Promise<PgBoss> {
	processQueues.ytimesyJobQueues ??= {};
	const queues = processQueues.ytimesyJobQueues;
	if (!queues[role]) {
		const ready = startJobQueue(role).catch((error) => {
			if (queues[role] === ready) delete queues[role];
			throw error;
		});
		queues[role] = ready;
	}
	return queues[role];
}

async function startJobQueue(role: QueueRole): Promise<PgBoss> {
	const boss = new PgBoss({
		db: { executeSql: (sql, values) => database().query(sql, values) },
		schema: "job_queue",
		supervise: role === "worker",
		schedule: role === "worker",
		migrate: role === "worker",
		useListenNotify: false,
	});
	boss.on("error", () => {
		// Do not log SQL, job payloads, or credentials from provider errors.
		console.warn("Job queue background operation failed; it will retry.");
	});
	try {
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
		await boss.createQueue(AGENT_TASK_EVENT_QUEUE, {
			retryLimit: 3,
			retryBackoff: true,
			retryDelay: 15,
			expireInSeconds: 30 * 60,
		});
		return boss;
	} catch (error) {
		await boss.stop({ graceful: false, timeout: 1000 }).catch(() => undefined);
		throw error;
	}
}

export async function enqueueAgentTaskEvent(eventId?: string) {
	const queue = await jobQueue();
	return queue.send(
		AGENT_TASK_EVENT_QUEUE,
		{ eventId: eventId ?? null },
		eventId ? { singletonKey: eventId } : undefined,
	);
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

export async function closeJobQueueForTests() {
	const queues = processQueues.ytimesyJobQueues;
	if (!queues) return;
	await Promise.all(
		Object.values(queues).map(async (ready) => {
			const queue = await ready.catch(() => undefined);
			await queue?.stop({ graceful: false, timeout: 1000 });
		}),
	);
	if (processQueues.ytimesyJobQueues === queues)
		delete processQueues.ytimesyJobQueues;
}
