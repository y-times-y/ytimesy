import { helperIdentities } from "#/domain/agent-panel";
import { userSteeringNotice } from "#/domain/agent-steering";
import { agentTaskTree } from "#/domain/agent-task";
import { subagentTaskViews } from "#/domain/subagent-tree";
import {
	type AgentSessionRecord,
	agentSessionForOwner,
	descendantAgentSessions,
} from "../adapters/agent-sessions";
import { stageServerPeerMessage } from "../adapters/server-peer-inbox";
import { enqueuePeerMessage } from "../jobs/queue";

export type HelperSteeringDeps = {
	readonly session: (
		userId: string,
		sessionId: string,
	) => Promise<AgentSessionRecord | null>;
	readonly descendants: (
		userId: string,
		rootId: string,
	) => Promise<readonly AgentSessionRecord[]>;
	readonly enqueue: typeof enqueuePeerMessage;
	readonly notifyLead: (
		rootId: string,
		id: string,
		message: string,
	) => Promise<void>;
	readonly now: () => number;
};

const liveDeps: HelperSteeringDeps = {
	session: agentSessionForOwner,
	descendants: descendantAgentSessions,
	enqueue: enqueuePeerMessage,
	notifyLead: stageServerPeerMessage,
	now: Date.now,
};

export class HelperSteeringError extends Error {}

/**
 * The user writes to one of a chat's running helpers from the agents list.
 * The message goes the way agent_send's steering goes (queued, delivered at
 * the helper's next model step), sent on behalf of the helper's parent so
 * delivery's own checks apply; the lead reads a one-line notice of it at its
 * next step or with the next request.
 */
export async function sendUserMessageToHelper(
	input: {
		readonly userId: string;
		readonly projectId: string;
		readonly rootSessionId: string;
		readonly helperId: string;
		readonly message: string;
		readonly requestId: string;
	},
	deps: HelperSteeringDeps = liveDeps,
) {
	const message = input.message.trim();
	if (!message) throw new HelperSteeringError("Write a message first.");
	const root = await deps.session(input.userId, input.rootSessionId);
	if (!root || root.projectId !== input.projectId || root.parentSessionId)
		throw new HelperSteeringError("That chat is not available.");
	const helpers = (await deps.descendants(input.userId, root.id)).filter(
		(session) => session.agentRole && session.userId === input.userId,
	);
	const helper = helpers.find((session) => session.id === input.helperId);
	if (!helper?.parentSessionId)
		throw new HelperSteeringError("That agent is not part of this chat.");
	if (helper.turnStatus !== "running")
		throw new HelperSteeringError(
			"That agent is no longer running; message the lead instead.",
		);
	const views = subagentTaskViews(root.id, [root, ...helpers], deps.now());
	const name =
		helperIdentities(
			agentTaskTree(root.id, helpers).map((task) => ({
				id: task.id,
				createdAt: task.createdAt,
				subagent: views.get(task.id),
			})),
		).get(helper.id)?.name ?? "a helper";
	await deps.enqueue(
		{
			userId: input.userId,
			senderId: helper.parentSessionId,
			recipientId: helper.id,
			message,
			fromUser: true,
		},
		`user:${helper.id}:${input.requestId}`,
	);
	await deps.notifyLead(
		root.id,
		`user-steer:${input.requestId}`,
		userSteeringNotice(name, message),
	);
	return { helperId: helper.id, name, status: "queued" as const };
}
