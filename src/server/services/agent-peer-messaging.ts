import { Effect } from "effect";
import { steeringTexts } from "#/domain/agent-steering";
import { sessionItemsFromUnknown } from "#/domain/session-item";
import { sidekickState } from "#/domain/sidekick";
import {
	type AgentSessionRecord,
	agentSessionForOwner,
	agentSessionMetadataForOwner,
} from "../adapters/agent-sessions";
import { hasActiveApiTurn } from "../adapters/api-turns";
import {
	removePendingServerPeerMessage,
	serverPeerMessageAccepted,
	stageServerPeerMessage,
} from "../adapters/server-peer-inbox";
import { enqueuePeerMessage } from "../jobs/queue";
import { sendHarnessWorkspaceTask } from "./harness-workspace-session";
import { machinesForAgentSession } from "./session-workspace-machines";
import type { WorkspaceMachines } from "./workspace-machines";

/** agent_send's steering, queued from a parent to one of its own subagents. */
export type PeerMessage = {
	readonly userId: string;
	readonly senderId: string;
	readonly recipientId: string;
	readonly message: string;
	/** The user wrote it from the chat's agents list; senderId is the recipient's parent. */
	readonly fromUser?: true;
	/** Model-only text after the message: who its @mentions name. */
	readonly context?: string;
};

/** Only a started direct subagent of the sender, same owner and project. */
async function steerableChild(
	sender: Pick<AgentSessionRecord, "id" | "userId" | "projectId">,
	recipientId: string,
) {
	const recipient = await agentSessionForOwner(sender.userId, recipientId);
	return recipient?.agentRole &&
		recipient.parentSessionId === sender.id &&
		recipient.projectId === sender.projectId &&
		recipient.taskState !== "draft"
		? recipient
		: null;
}

export async function queueAgentPeerMessage(
	sender: AgentSessionRecord,
	recipientId: string,
	message: string,
	requestId: string,
) {
	if (!message.trim() || message.length > 8_000)
		throw new Error("A message must contain 1–8,000 characters.");
	const recipient = await steerableChild(sender, recipientId);
	if (!recipient?.listedModelId)
		throw new Error("That started subagent of yours is not available.");
	await enqueuePeerMessage(
		{
			userId: sender.userId,
			senderId: sender.id,
			recipientId,
			message: message.trim(),
		},
		`${sender.id}:${requestId}`,
	);
	return {
		taskId: recipientId,
		status: "queued",
		delivery: "next_safe_point",
	};
}

/** Revalidated on delivery; steering grants no access beyond the subagent's role. */
export class PeerMessagePendingError extends Error {}

export async function deliverAgentPeerMessage(
	machines: WorkspaceMachines,
	message: PeerMessage,
	messageId: string,
) {
	const sender = await agentSessionMetadataForOwner(
		message.userId,
		message.senderId,
	);
	if (!sender) return;
	const recipient = await steerableChild(sender, message.recipientId);
	if (!recipient) return;
	// Lead mode fusion: a retired sidekick takes no new round. Waking it would
	// let it write in the lead's checkout beside the lead.
	if (sidekickState(recipient)?.retired && recipient.turnStatus !== "running")
		return;
	const { text, runtimeText } = steeringTexts({
		sender: message.fromUser
			? { kind: "user" }
			: { kind: "parent", title: sender.title, id: sender.id },
		message: message.message,
		messageId,
		...(message.context ? { context: message.context } : {}),
	});
	if (await serverPeerMessageAccepted(recipient.id, messageId)) return;
	if (
		sessionItemsFromUnknown(recipient.items).some(
			(item) =>
				item.kind === "userMessage" &&
				(item.text === text || item.text === runtimeText),
		)
	)
		return;
	if (
		recipient.turnStatus === "running" ||
		(await hasActiveApiTurn(recipient.userId, recipient.id))
	) {
		await stageServerPeerMessage(recipient.id, messageId, runtimeText);
		throw new PeerMessagePendingError(
			"Steering awaits the subagent's next model safe point.",
		);
	}
	// A turn may finish just before its safe-point consumer reads the mailbox.
	// Remove unconsumed staging before starting a follow-up, avoiding double injection.
	await removePendingServerPeerMessage(recipient.id, messageId);
	if (!recipient.listedModelId)
		throw new Error("The subagent has no selected model.");
	const view = await Effect.runPromise(
		sendHarnessWorkspaceTask(
			machinesForAgentSession(machines, recipient),
			{
				userId: message.userId,
				projectId: recipient.projectId,
				sessionId: recipient.id,
				harnessId: recipient.harness,
				createNew: false,
			},
			{
				modelId: recipient.listedModelId,
				text,
				runtimeText,
			},
		),
	);
	if (view.connection.status === "failed" || view.turnStatus === "failed")
		throw new Error(
			"Steering dispatch failed; inspect the subagent's connection.",
		);
}
