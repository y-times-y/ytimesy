import { createHash } from "node:crypto";
import { type ToolSet, tool } from "ai";
import { Effect } from "effect";
import { z } from "zod";
import type { AgentProviderId } from "#/domain/agent-provider";
import { wakeMessageId } from "#/domain/pull-request-wake";
import {
	messageThreadInput,
	startThreadInput,
	stopThreadInput,
	threadsOverview,
	threadTimesText,
	Y_SQUARED_MAX_STARTS_PER_TURN,
	Y_SQUARED_MESSAGE_THREAD_DESCRIPTION,
	Y_SQUARED_MESSAGE_THREAD_TOOL,
	Y_SQUARED_START_THREAD_DESCRIPTION,
	Y_SQUARED_START_THREAD_TOOL,
	Y_SQUARED_STOP_THREAD_DESCRIPTION,
	Y_SQUARED_STOP_THREAD_TOOL,
	Y_SQUARED_THREAD_LIMIT,
	Y_SQUARED_THREAD_TOOL,
	Y_SQUARED_THREADS_TOOL,
} from "#/domain/y-squared";
import {
	type CrewRow,
	type CrewState,
	crewDigest,
} from "#/domain/y-squared-crew";
import {
	agentSessionMetadataForOwner,
	listSidebarAgentSessions,
} from "../adapters/agent-sessions";
import {
	type YSquaredCrewClient,
	ySquaredCrewFor,
} from "../adapters/y-squared-crew-client";
import {
	sendComposerMessage,
	stopTurnKeepingQueue,
} from "./queued-user-messages";
import type { WorkspaceMachines } from "./workspace-machines";

type Deps = {
	readonly list: typeof listSidebarAgentSessions;
	/** The project's crew (one Durable Object request); null where there is none (local development). */
	readonly crew: (projectId: string) => YSquaredCrewClient | null;
	readonly now: () => number;
	/** One chat's row without its transcript (metadata only). */
	readonly metadata: typeof agentSessionMetadataForOwner;
	/** The person's own send path: queues behind a running turn, else starts a turn (admission applies). */
	readonly send: (
		machines: WorkspaceMachines,
		...args: Parameters<typeof sendComposerMessage> extends [
			unknown,
			...infer Rest,
		]
			? Rest
			: never
	) => Promise<{ readonly turnStatus: string; readonly failed?: string }>;
	/** The Stop button's path. */
	readonly stop: (
		machines: WorkspaceMachines,
		...args: Parameters<typeof stopTurnKeepingQueue> extends [
			unknown,
			...infer Rest,
		]
			? Rest
			: never
	) => Promise<{ readonly turnStatus: string }>;
};

// Bound at call time, so a module that imports this file never reads them early.
const defaultDeps: Deps = {
	list: (...args) => listSidebarAgentSessions(...args),
	crew: (projectId) => ySquaredCrewFor(projectId),
	now: () => Date.now(),
	metadata: (...args) => agentSessionMetadataForOwner(...args),
	send: async (machines, scope, input) => {
		const view = await Effect.runPromise(
			sendComposerMessage(machines, scope, input),
		);
		return {
			turnStatus: view.turnStatus,
			...(view.connection.status === "failed"
				? { failed: view.connection.message }
				: {}),
		};
	},
	stop: async (machines, scope) => {
		const view = await Effect.runPromise(stopTurnKeepingQueue(machines, scope));
		return { turnStatus: view.turnStatus };
	},
};

type Sidebar = Awaited<ReturnType<typeof listSidebarAgentSessions>>[number];

/** A sidebar row as a crew row: metadata only, no transcript. */
function rowFromSidebar(chat: Sidebar): CrewRow {
	const state: CrewState = chat.waitingOn
		? chat.waitingOn === "failed"
			? "failed"
			: "waiting"
		: chat.workingSince
			? "working"
			: "finished";
	return {
		sessionId: chat.id,
		title: chat.title,
		state,
		waitingOn: chat.waitingOn ?? null,
		prUrl: null,
		lastReply: null,
		lastRequest: null,
		updatedAt: Date.parse(chat.workingSince ?? chat.updatedAt ?? "") || 0,
		createdAt: 0,
		lastActiveAt: 0,
		workingSince:
			state === "working"
				? Date.parse(chat.workingSince ?? chat.updatedAt ?? "") || null
				: null,
	};
}

/**
 * Y²'s read tools (src/domain/y-squared.ts): every thread of its project,
 * and one thread's details. They read the project's crew (one Durable
 * Object request, no transcript): rows each thread's chat object pushed when
 * its turn started and settled. Y² has no machine.
 */
export function ySquaredTools(input: {
	readonly userId: string;
	readonly projectId: string;
	/** Y² itself, left out of what it reports. */
	readonly selfId: string;
	/** The turn's workspace machines: only passed on to the send and stop paths (Y² itself never gets a VM). */
	readonly machines?: WorkspaceMachines;
	/** Y²'s own route, which the threads it starts and wakes inherit. */
	readonly modelId?: string | null;
	readonly harnessId?: AgentProviderId;
	/** The turn's id: keys the sends so a replayed step does not send twice. */
	readonly turnId?: string;
	readonly deps?: Partial<Deps>;
}): ToolSet {
	const deps = { ...defaultDeps, ...input.deps };
	let starts = 0;
	/** A root thread of this project that is not Y²: metadata only, no transcript. */
	const ownThread = async (id: string) => {
		if (id === input.selfId) return null;
		const chat = await deps.metadata(input.userId, id);
		if (
			!chat ||
			chat.projectId !== input.projectId ||
			chat.id === input.selfId ||
			chat.parentSessionId ||
			chat.agentRole
		)
			return null;
		return chat;
	};
	const sendKey = (kind: string, ...parts: string[]) =>
		wakeMessageId(
			`y2-${kind}:${input.turnId ?? "no-turn"}:${createHash("sha256")
				.update(parts.join("\u0000"))
				.digest("hex")}`,
		);
	/** Tells the crew Y² is about to send (before it does), so that thread's start is not taken for the person's. */
	const markSent = async (sessionId: string | null) => {
		await deps
			.crew(input.projectId)
			?.noteY2Sent?.(sessionId)
			.catch(() => undefined);
	};
	const noThread = "No such thread in this project.";
	const noMachines = "Threads cannot be run here.";
	/** Metadata of the project's threads: the cold start and where no crew exists. */
	const fromSidebar = async () =>
		(await deps.list(input.userId, input.projectId))
			.filter((chat) => chat.id !== input.selfId && !chat.unused)
			.slice(0, Y_SQUARED_THREAD_LIMIT)
			.map(rowFromSidebar);
	/** The crew's rows; an empty, never-filled crew is filled once from the sidebar. */
	const crewRows = async (): Promise<CrewRow[]> => {
		const crew = deps.crew(input.projectId);
		if (!crew) return fromSidebar();
		const listed = await crew.list();
		const rows = listed.rows.filter((row) => row.sessionId !== input.selfId);
		if (rows.length || listed.reconciled) return rows;
		const seeded = await fromSidebar();
		await crew.reconcile(seeded).catch(() => undefined);
		return seeded;
	};
	return {
		[Y_SQUARED_THREADS_TOOL]: tool({
			description:
				"Every thread in this project: what it needs from the person, whether it is working, when it was last active and created, its last request, last reply and pull request. Threads that need the person come first, then the most recently active.",
			inputSchema: z.object({}),
			execute: async () => {
				const now = deps.now();
				return threadsOverview(
					(await crewRows()).map((row) => crewDigest(row, now)),
					now,
				);
			},
		}),
		[Y_SQUARED_THREAD_TOOL]: tool({
			description:
				"One thread's details: its status, when it was last active and created, its last request, last reply and pull request. Pass the id from the threads list.",
			inputSchema: z.object({
				id: z.string().min(1).max(64).describe("The thread's id"),
			}),
			execute: async ({ id }) => {
				const crew = deps.crew(input.projectId);
				const row = crew
					? await crew.thread(id)
					: (await fromSidebar()).find((entry) => entry.sessionId === id);
				if (!row || row.sessionId === input.selfId)
					return "No such thread in this project.";
				const now = deps.now();
				const digest = crewDigest(row, now);
				return [
					`"${digest.title}" (id ${digest.id})`,
					digest.waitingOn
						? `Status: it ${digest.waitingOn}`
						: digest.workingForMinutes !== null
							? `Status: working for ${digest.workingForMinutes} min`
							: "Status: idle",
					threadTimesText(digest, now),
					digest.lastRequest ? `Last request: ${digest.lastRequest}` : "",
					digest.pullRequest ? `Pull request: ${digest.pullRequest}` : "",
					digest.lastReply
						? `Last reply: ${digest.lastReply}`
						: "No reply yet.",
				]
					.filter(Boolean)
					.join("\n");
			},
		}),
		[Y_SQUARED_START_THREAD_TOOL]: tool({
			description: Y_SQUARED_START_THREAD_DESCRIPTION,
			inputSchema: startThreadInput,
			execute: async ({ title, brief }) => {
				if (!input.machines || !input.modelId || !input.harnessId)
					return noMachines;
				if (starts >= Y_SQUARED_MAX_STARTS_PER_TURN)
					return `Not started: at most ${Y_SQUARED_MAX_STARTS_PER_TURN} threads may be started in one turn. Tell the person what is left to start.`;
				starts++;
				await markSent(null);
				const sent = await deps.send(
					input.machines,
					{
						userId: input.userId,
						projectId: input.projectId,
						harnessId: input.harnessId,
						createNew: true,
					},
					{
						// The first line names the chat (sessionTitleFromText).
						text: `${title}\n\n${brief}`,
						modelId: input.modelId,
						idempotencyKey: sendKey("start", title, brief),
					},
				);
				if (sent.failed) return `Not started: ${sent.failed}`;
				return sent.turnStatus === "running"
					? `Started "${title}". You wake when it finishes or needs the person.`
					: `Queued "${title}" behind the budget/concurrency limit; it starts by itself when there is room. You wake when it finishes or needs the person.`;
			},
		}),
		[Y_SQUARED_MESSAGE_THREAD_TOOL]: tool({
			description: Y_SQUARED_MESSAGE_THREAD_DESCRIPTION,
			inputSchema: messageThreadInput,
			execute: async ({ id, text, mode }) => {
				if (!input.machines || !input.modelId) return noMachines;
				const chat = await ownThread(id);
				if (!chat) return noThread;
				await markSent(chat.id);
				const interrupted =
					mode === "interrupt" && chat.turnStatus === "running";
				const steered = mode === "steer" && chat.turnStatus === "running";
				if (interrupted)
					await deps.stop(input.machines, {
						userId: input.userId,
						projectId: input.projectId,
						sessionId: chat.id,
						harnessId: chat.harness,
						createNew: false,
					});
				const sent = await deps.send(
					input.machines,
					{
						userId: input.userId,
						projectId: input.projectId,
						sessionId: chat.id,
						harnessId: chat.harness,
						createNew: false,
					},
					{
						text,
						modelId: chat.listedModelId ?? input.modelId,
						idempotencyKey: sendKey("message", chat.id, text),
						// Steer: the row waits already released, so the running turn takes
						// it at its next step (releaseQueuedComposerMessage's mark). An idle
						// thread starts a turn as for any send; if the turn ends before the
						// row is stored the send starts the next turn.
						...(steered ? { released: true } : {}),
					},
				);
				if (sent.failed) return `Not sent: ${sent.failed}`;
				if (interrupted)
					return `Stopped the running turn of "${chat.title}" and sent the message; ${
						sent.turnStatus === "running"
							? "its new turn started."
							: "it is queued and starts by itself."
					}`;
				if (steered)
					return `Steering "${chat.title}": the message goes in at its next step (a Claude Code thread takes it after its next tool call, a runner box up to 10 s late); if its turn ends first it starts its next turn with it.`;
				return chat.turnStatus === "running"
					? `Queued the message in "${chat.title}"; it goes in when its current turn ends.`
					: sent.turnStatus === "running"
						? `Sent to "${chat.title}": its turn started.`
						: `Queued the message for "${chat.title}" behind the budget/concurrency limit; it starts by itself when there is room.`;
			},
		}),
		[Y_SQUARED_STOP_THREAD_TOOL]: tool({
			description: Y_SQUARED_STOP_THREAD_DESCRIPTION,
			inputSchema: stopThreadInput,
			execute: async ({ id }) => {
				if (!input.machines) return noMachines;
				const chat = await ownThread(id);
				if (!chat) return noThread;
				if (chat.turnStatus !== "running")
					return `"${chat.title}" is not running.`;
				await deps.stop(input.machines, {
					userId: input.userId,
					projectId: input.projectId,
					sessionId: chat.id,
					harnessId: chat.harness,
					createNew: false,
				});
				return `Stopped "${chat.title}". Messages already queued in it still go on.`;
			},
		}),
	};
}
