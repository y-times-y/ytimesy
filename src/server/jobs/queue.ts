import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import { ENVIRONMENT_JOB_TIMEOUT_SECONDS } from "#/domain/environment-build-limits";
import type { EnvironmentModel } from "#/domain/environment-model";
import {
	backgroundJobId,
	dispatchBackgroundJob,
} from "../adapters/background-job-dispatch";
import { database } from "../adapters/database";
import { scopedDatabase, scopedResource } from "../adapters/database-scope";
import type { PeerMessage } from "../services/agent-peer-messaging";

export const PREPARE_WORKSPACE_QUEUE = "prepare-workspace";
export const REFRESH_WORKSPACE_QUEUE = "refresh-workspace-snapshot";
export const AGENT_TASK_EVENT_QUEUE = "agent-task-event";
export const AGENT_PEER_MESSAGE_QUEUE = "agent-peer-message";
export const SESSION_CHECKPOINT_QUEUE = "session-checkpoint";
export const PR_REPAIR_QUEUE = "pr-repair";

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
const producerResource = Symbol("request-job-producer");

/** Share startup across callers and hot reloads; jobs use the application's bounded pool. */
export function jobQueue(role: QueueRole = "producer"): Promise<PgBoss> {
	if (scopedDatabase()) {
		if (role !== "producer")
			throw new Error("A request cannot start a persistent job worker.");
		const producer = scopedResource(
			producerResource,
			() => startJobQueue("producer"),
			(boss) => boss.stop({ graceful: false, timeout: 1000 }),
		);
		if (!producer)
			throw new Error("Request job producer scope is unavailable.");
		return producer;
	}
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
		await boss.createQueue(AGENT_PEER_MESSAGE_QUEUE, {
			policy: "singleton",
			retryLimit: 5760,
			retryDelay: 15,
			retryBackoff: false,
			expireInSeconds: 30 * 60,
		});
		await boss.createQueue(SESSION_CHECKPOINT_QUEUE, {
			policy: "singleton",
			retryLimit: 3,
			retryBackoff: true,
			retryDelay: 15,
			expireInSeconds: 15 * 60,
		});
		await boss.createQueue(PR_REPAIR_QUEUE, {
			policy: "singleton",
			retryLimit: 2,
			retryDelay: 15,
			expireInSeconds: 180,
		});
		return boss;
	} catch (error) {
		await boss.stop({ graceful: false, timeout: 1000 }).catch(() => undefined);
		throw error;
	}
}

export async function enqueueAgentTaskEvent(eventId?: string) {
	const id = randomUUID();
	if (
		await dispatchBackgroundJob({
			id,
			kind: "task-event",
			eventId: eventId ?? null,
		})
	)
		return id;
	const queue = await jobQueue();
	return queue.send(
		AGENT_TASK_EVENT_QUEUE,
		{ eventId: eventId ?? null },
		eventId ? { singletonKey: eventId } : undefined,
	);
}

export async function enqueuePrRepair() {
	const id = randomUUID();
	if (await dispatchBackgroundJob({ id, kind: "pr-repair" })) return id;
	return (await jobQueue()).send(
		PR_REPAIR_QUEUE,
		{},
		{ singletonKey: "repair-sweep" },
	);
}

export async function enqueuePeerMessage(
	message: PeerMessage,
	requestKey: string,
) {
	const id = backgroundJobId(requestKey);
	if (
		await dispatchBackgroundJob({
			id,
			kind: "peer-message",
			...message,
		})
	)
		return id;
	const queue = await jobQueue();
	return queue.send(AGENT_PEER_MESSAGE_QUEUE, message, {
		singletonKey: requestKey,
	});
}

export async function enqueueSessionCheckpoint(
	userId: string,
	sessionId: string,
) {
	const id = randomUUID();
	if (
		await dispatchBackgroundJob({ id, kind: "checkpoint", userId, sessionId })
	)
		return id;
	const queue = await jobQueue();
	return queue.send(
		SESSION_CHECKPOINT_QUEUE,
		{ userId, sessionId },
		{ singletonKey: sessionId },
	);
}

export const postgresJobQueue: WorkspaceJobQueue = {
	async enqueuePrepare(workspaceId, repairModel) {
		const id = randomUUID();
		if (
			await dispatchBackgroundJob({
				id,
				kind: "prepare",
				workspaceId,
				force: true,
				repairModel: repairModel ?? null,
			})
		)
			return id;
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
