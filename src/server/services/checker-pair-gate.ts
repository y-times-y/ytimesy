import { subagentTree } from "#/domain/subagent-tree";
import {
	type AgentSessionRecord,
	descendantAgentSessions,
} from "../adapters/agent-sessions";
import { childReportEventsSince } from "../adapters/agent-task-events";
import { stageServerPeerMessage } from "../adapters/server-peer-inbox";
import {
	boundedNotificationText,
	subagentReportNotification,
} from "./agent-task-event-delivery";

/**
 * checkerMode=pair (src/domain/checker-pair.ts): the judge's turn waits for
 * its workers like a fusion lead waits for its sidekick. checker_worker
 * waits for a report only until its step's deadline; after that the
 * judge makes no model call while a worker still works (its turn waits,
 * across durable steps), and a worker's report is put in the judge's
 * mailbox the moment it exists, so the next model call carries it.
 */

/** A finished worker's report event may lag its turn's end by this much. */
const REPORT_LAG_MS = 60_000;
const POLL_MS = 3_000;

export type CheckerPairGateDeps = {
	readonly now: () => number;
	readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
	readonly workers: (
		userId: string,
		judgeId: string,
	) => Promise<readonly AgentSessionRecord[]>;
	readonly reportEvents: typeof childReportEventsSince;
	readonly stage: typeof stageServerPeerMessage;
};

const defaultDeps: CheckerPairGateDeps = {
	now: () => Date.now(),
	sleep: (ms, signal) =>
		new Promise((resolve) => {
			const timer = setTimeout(done, ms);
			function done() {
				clearTimeout(timer);
				signal.removeEventListener("abort", done);
				resolve();
			}
			signal.addEventListener("abort", done, { once: true });
		}),
	workers: async (userId, judgeId) =>
		(await descendantAgentSessions(userId, judgeId)).filter(
			(child) => child.parentSessionId === judgeId,
		),
	reportEvents: (...args) => childReportEventsSince(...args),
	stage: (...args) => stageServerPeerMessage(...args),
};

/**
 * Stages the reports that exist in the judge's mailbox; true while a
 * worker still works (or just finished and its report is not written yet).
 */
async function workersBusy(
	deps: CheckerPairGateDeps,
	judge: AgentSessionRecord,
) {
	const workers = await deps.workers(judge.userId, judge.id);
	const now = deps.now();
	const nodes = subagentTree(judge.id, [judge, ...workers], now).nodes;
	let busy = false;
	for (const worker of workers) {
		const events = await deps.reportEvents(worker.id, worker.createdAt);
		for (const event of events.filter((entry) => entry.pending))
			await deps.stage(
				judge.id,
				event.id,
				boundedNotificationText(subagentReportNotification(event)),
			);
		const live = !!nodes.find((node) => node.id === worker.id)?.live;
		const reportDue =
			!events.length && now - Date.parse(worker.updatedAt) < REPORT_LAG_MS;
		if (live || reportDue) busy = true;
	}
	return busy;
}

/**
 * Before a pair judge's model call: "ready" when no worker works (their
 * reports are in the judge's mailbox); "wait" when one still works at
 * `waitUntil`, so the step ends and the next one waits on.
 */
export async function checkerPairGate(input: {
	readonly judge: AgentSessionRecord;
	readonly signal: AbortSignal;
	readonly waitUntil: number;
	readonly deps?: Partial<CheckerPairGateDeps>;
}): Promise<"ready" | "wait"> {
	const deps = { ...defaultDeps, ...input.deps };
	for (;;) {
		input.signal.throwIfAborted();
		if (!(await workersBusy(deps, input.judge))) return "ready";
		const left = input.waitUntil - deps.now();
		if (left <= 0) return "wait";
		await deps.sleep(Math.min(POLL_MS, left), input.signal);
	}
}
