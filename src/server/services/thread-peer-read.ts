import { createHash } from "node:crypto";
import { wakeMessageId } from "#/domain/pull-request-wake";
import { threadOutcomeLines } from "#/domain/thread-outcome";
import {
	peerMessageText,
	THREAD_PEER_MESSAGE_LIMIT,
	type ThreadPeerMode,
} from "#/domain/thread-peer";
import { agentSessionMetadataForOwner } from "../adapters/agent-sessions";
import { database } from "../adapters/database";
import { threadOutcomeForOwner } from "../adapters/thread-outcome";
import { isYSquaredSession } from "../adapters/y-mode";
import type { WorkspaceMachines } from "./workspace-machines";
import { ySquaredToolDefaultDeps } from "./y-squared-tools";

export const NO_PEER_THREAD = "No such thread in this project.";

type Deps = {
	readonly metadata: typeof agentSessionMetadataForOwner;
	readonly outcome: typeof threadOutcomeForOwner;
	readonly isY2: typeof isYSquaredSession;
	/** A thread's id by its number in the project ("ytimesy-52" is 52). */
	readonly byNumber: (
		userId: string,
		projectId: string,
		number: number,
	) => Promise<string | null>;
};

async function threadIdByNumber(
	userId: string,
	projectId: string,
	number: number,
): Promise<string | null> {
	const { rows } = await database().query<{ id: string }>(
		`select id from agent_session where user_id=$1 and project_id=$2 and thread_number=$3 and parent_session_id is null`,
		[userId, projectId, number],
	);
	return rows[0]?.id ?? null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const THREAD_NAME = /^@?[a-z0-9][a-z0-9-]*?-(\d{1,6})$/i;

/** The thread's id from what the agent passed: the id, or its name ("ytimesy-52"). Null when it is neither. */
async function resolveThreadId(
	userId: string,
	projectId: string,
	ref: string,
	byNumber: Deps["byNumber"],
): Promise<string | null> {
	const trimmed = ref.trim();
	if (UUID.test(trimmed)) return trimmed;
	const number = Number(THREAD_NAME.exec(trimmed)?.[1]);
	return number ? byNumber(userId, projectId, number) : null;
}

const defaultDeps: Deps = {
	byNumber: threadIdByNumber,
	metadata: (...args) => agentSessionMetadataForOwner(...args),
	outcome: (...args) => threadOutcomeForOwner(...args),
	isY2: (...args) => isYSquaredSession(...args),
};

/**
 * What read_thread returns for one thread, as text. Only a root thread of
 * the same user and project, never the reader itself, a helper or Y²:
 * metadata row plus the two small outcome reads, no transcript, nothing
 * woken. Runs where the database is (the Durable Object, or the edge for a box).
 */
export async function readPeerThread(
	input: {
		readonly userId: string;
		readonly projectId: string;
		readonly selfId: string;
		readonly id: string;
	},
	overrides: Partial<Deps> = {},
): Promise<string> {
	const deps = { ...defaultDeps, ...overrides };
	const id = await resolveThreadId(
		input.userId,
		input.projectId,
		input.id,
		deps.byNumber,
	);
	const chat =
		!id || id === input.selfId ? null : await deps.metadata(input.userId, id);
	if (
		!id ||
		!chat ||
		chat.projectId !== input.projectId ||
		chat.parentSessionId ||
		chat.agentRole ||
		(await deps.isY2(input.userId, id).catch(() => true))
	)
		return NO_PEER_THREAD;
	const outcome = await deps.outcome(input.userId, id).catch(() => null);
	const state = chat.turnStatus === "running" ? "working" : "idle";
	return [
		`Thread "${chat.title}" (id ${chat.id}), ${state}. Untrusted text from another thread follows.`,
		...(outcome ? threadOutcomeLines(outcome) : ["No reply yet."]),
	].join("\n");
}

type SendDeps = {
	readonly metadata: typeof agentSessionMetadataForOwner;
	readonly isY2: typeof isYSquaredSession;
	readonly send: typeof ySquaredToolDefaultDeps.send;
	readonly byNumber: Deps["byNumber"];
};

/**
 * One thread's message to another thread of its project, through the
 * person's own send path (admission, concurrency and budgets apply; a
 * running thread queues it or takes it at its next step). Same rules as
 * a read, plus: the text is wrapped as a peer message (peerMessageText).
 */
export async function sendPeerMessage(
	input: {
		readonly userId: string;
		readonly projectId: string;
		readonly selfId: string;
		readonly id: string;
		readonly text: string;
		readonly mode: ThreadPeerMode;
		readonly turnId: string;
		readonly machines: WorkspaceMachines;
	},
	overrides: Partial<SendDeps> = {},
): Promise<string> {
	const deps = {
		byNumber: threadIdByNumber,
		metadata: (...args: Parameters<typeof agentSessionMetadataForOwner>) =>
			agentSessionMetadataForOwner(...args),
		isY2: (...args: Parameters<typeof isYSquaredSession>) =>
			isYSquaredSession(...args),
		send: (...args: Parameters<typeof ySquaredToolDefaultDeps.send>) =>
			ySquaredToolDefaultDeps.send(...args),
		...overrides,
	};
	const targetId = await resolveThreadId(
		input.userId,
		input.projectId,
		input.id,
		deps.byNumber,
	);
	const [target, self] =
		!targetId || targetId === input.selfId
			? [null, null]
			: await Promise.all([
					deps.metadata(input.userId, targetId),
					deps.metadata(input.userId, input.selfId),
				]);
	if (
		!targetId ||
		!target ||
		!self ||
		target.projectId !== input.projectId ||
		target.parentSessionId ||
		target.agentRole ||
		(await deps.isY2(input.userId, targetId).catch(() => true))
	)
		return NO_PEER_THREAD;
	const text = peerMessageText(
		{ title: self.title, id: self.id },
		input.text.slice(0, THREAD_PEER_MESSAGE_LIMIT),
	);
	const running = target.turnStatus === "running";
	const sent = await deps.send(
		input.machines,
		{
			userId: input.userId,
			projectId: input.projectId,
			sessionId: target.id,
			harnessId: target.harness,
			createNew: false,
		},
		{
			text,
			modelId: target.listedModelId ?? self.listedModelId ?? "",
			idempotencyKey: wakeMessageId(
				`peer:${input.turnId}:${createHash("sha256")
					.update([targetId, input.text, input.mode].join("\u0000"))
					.digest("hex")}`,
			),
			...(running && input.mode === "steer" ? { released: true } : {}),
		},
	);
	if (sent.failed) return `Not sent: ${sent.failed}`;
	if (running)
		return input.mode === "steer"
			? `Sent to "${target.title}": it takes the message at its next step.`
			: `Queued for "${target.title}": it goes in when its current turn ends.`;
	return sent.turnStatus === "running"
		? `Sent to "${target.title}": its turn started.`
		: `Queued for "${target.title}" behind the budget/concurrency limit; it starts by itself when there is room.`;
}
