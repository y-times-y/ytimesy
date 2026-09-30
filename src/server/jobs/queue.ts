import { PgBoss } from "pg-boss";
import { ENVIRONMENT_JOB_TIMEOUT_SECONDS } from "#/domain/environment-build-limits";
import type { EnvironmentModel } from "#/domain/environment-model";
import { database } from "../adapters/database";

export const PREPARE_WORKSPACE_QUEUE = "prepare-workspace";
export const REFRESH_WORKSPACE_QUEUE = "refresh-workspace-snapshot";
export const AGENT_TASK_EVENT_QUEUE = "agent-task-event";
export const START_COMPETITION_QUEUE = "start-agent-competition";
export const SESSION_CHECKPOINT_QUEUE = "session-checkpoint";

export interface WorkspaceJobQueue {
	enqueuePrepare(
		workspaceId: string,
		repairModel?: EnvironmentModel | null,
	): Promise<string | null>;
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
			expireInSeconds: ENVIRONMENT_JOB_TIMEOUT_SECONDS,
		});
		await boss.createQueue(REFRESH_WORKSPACE_QUEUE, {
			policy: "singleton",
			retryLimit: 1,
			expireInSeconds: ENVIRONMENT_JOB_TIMEOUT_SECONDS,
		});
		if (role === "worker") {
			for (const name of [PREPARE_WORKSPACE_QUEUE, REFRESH_WORKSPACE_QUEUE])
				await boss.updateQueue(name, {
					expireInSeconds: ENVIRONMENT_JOB_TIMEOUT_SECONDS,
				});
		}
		await boss.createQueue(AGENT_TASK_EVENT_QUEUE, {
			retryLimit: 3,
			retryBackoff: true,
			retryDelay: 15,
			expireInSeconds: 30 * 60,
		});
		await boss.createQueue(START_COMPETITION_QUEUE, {
			policy: "singleton",
			retryLimit: 2,
			retryBackoff: true,
			expireInSeconds: 30 * 60,
		});
		await boss.createQueue(SESSION_CHECKPOINT_QUEUE, {
			policy: "singleton",
			retryLimit: 3,
			retryBackoff: true,
			retryDelay: 15,
			expireInSeconds: 15 * 60,
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

export async function enqueueCompetition(rootSessionId: string) {
	const queue = await jobQueue();
	return queue.send(
		START_COMPETITION_QUEUE,
		{ rootSessionId },
		{ singletonKey: rootSessionId },
	);
}

export async function enqueueSessionCheckpoint(
	userId: string,
	sessionId: string,
) {
	const queue = await jobQueue();
	return queue.send(
		SESSION_CHECKPOINT_QUEUE,
		{ userId, sessionId },
		{ singletonKey: sessionId },
	);
}

export const postgresJobQueue: WorkspaceJobQueue = {
	async enqueuePrepare(workspaceId, repairModel) {
		const queue = await jobQueue();
		return queue.send(
			PREPARE_WORKSPACE_QUEUE,
			{ workspaceId, repairModel: repairModel ?? null },
			{ singletonKey: workspaceId, ...(repairModel ? { retryLimit: 0 } : {}) },
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
