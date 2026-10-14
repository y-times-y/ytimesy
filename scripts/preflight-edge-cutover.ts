import { readFile } from "node:fs/promises";
import { PgBoss } from "pg-boss";
import { closeDatabase, database } from "../src/server/adapters/database";
import {
	AGENT_PEER_MESSAGE_QUEUE,
	AGENT_TASK_EVENT_QUEUE,
	PR_REPAIR_QUEUE,
	PREPARE_WORKSPACE_QUEUE,
	REFRESH_WORKSPACE_QUEUE,
	SESSION_CHECKPOINT_QUEUE,
} from "../src/server/jobs/queue";

// Inventory only: do not claim, delete, retry or execute existing user work.
const development = "exampledevprojectref";
if (
	(await readFile("supabase/.temp/project-ref", "utf8")).trim() !==
		development ||
	!new URL(process.env.DATABASE_URL ?? "").username.includes(development)
)
	throw new Error("Not the approved development database.");
const boss = new PgBoss({
	schema: "job_queue",
	db: { executeSql: (sql, values) => database().query(sql, values) },
	migrate: false,
	schedule: false,
	supervise: false,
	useListenNotify: false,
});
boss.on("error", () => console.warn("Cutover inventory query failed."));
let phase = "queue-start";
try {
	await boss.start();
	phase = "turn-inventory";
	const turns = await database().query<{
		executor: string;
		state: string;
		count: string;
	}>(
		"select executor,state,count(*)::text as count from api_turn where state in ('queued','running') group by executor,state order by executor,state",
	);
	const queues = [];
	for (const name of [
		PREPARE_WORKSPACE_QUEUE,
		REFRESH_WORKSPACE_QUEUE,
		AGENT_TASK_EVENT_QUEUE,
		AGENT_PEER_MESSAGE_QUEUE,
		// Retired with competitions; inventoried in case old jobs remain.
		"start-agent-competition",
		SESSION_CHECKPOINT_QUEUE,
		PR_REPAIR_QUEUE,
		// Retired with durable task plans; inventoried in case old jobs remain.
		"durable-work-plan",
	]) {
		phase = `queue-inventory:${name}`;
		if (!(await boss.getQueue(name))) {
			queues.push({ name, active: 0, queued: 0, deferred: 0, absent: true });
			continue;
		}
		const [stats] = await boss.getQueueStats(name, { force: true });
		if (!stats) throw new Error("Legacy queue inventory is incomplete.");
		queues.push({
			name,
			active: stats.activeCount,
			queued: stats.queuedCount,
			deferred: stats.deferredCount,
		});
	}
	const nodeTurns = turns.rows
		.filter((row) => row.executor === "node")
		.reduce((total, row) => total + Number(row.count), 0);
	const jobs = queues.reduce(
		(total, queue) => total + queue.active + queue.queued + queue.deferred,
		0,
	);
	console.log(
		JSON.stringify(
			{
				activeTurns: turns.rows,
				legacyQueues: queues,
				canRetireNode: nodeTurns === 0 && jobs === 0,
				note: "An empty backlog is necessary but not sufficient: live model/tools and recovery must also pass.",
			},
			null,
			2,
		),
	);
} catch (error) {
	const code =
		error &&
		typeof error === "object" &&
		"code" in error &&
		/^[A-Z0-9]{3,24}$/.test(String(error.code))
			? String(error.code)
			: "unclassified";
	console.error(JSON.stringify({ phase, code }));
	throw new Error(
		"Development cutover inventory failed; no executor was stopped and no work was changed.",
	);
} finally {
	await boss.stop({ graceful: false, timeout: 1000 }).catch(() => undefined);
	await closeDatabase();
}
