import type { ModelMessage } from "ai";
import { parseSteering } from "#/domain/agent-steering";
import { SessionItemId } from "#/domain/ids";
import type { UserMessageItem } from "#/domain/session-item";
import { database } from "./database";
import {
	forgetPeerInboxObservation,
	peerInboxMayHaveMessages,
} from "./peer-inbox-observation";
import { isSetupCatchUpRow } from "./setup-catch-up";

export async function stageServerPeerMessage(
	recipientId: string,
	id: string,
	message: string,
) {
	await database().query(
		"insert into agent_peer_inbox(id,recipient_id,message) values($1,$2,$3) on conflict(id) do nothing",
		[id, recipientId, message],
	);
	forgetPeerInboxObservation(recipientId);
}
export async function serverPeerMessageAccepted(
	recipientId: string,
	id: string,
) {
	const result = await database().query<{ accepted: boolean }>(
		"select accepted from agent_peer_inbox where recipient_id=$1 and id=$2",
		[recipientId, id],
	);
	return result.rows[0]?.accepted ?? false;
}
/** Whether the recipient's mailbox holds this message, accepted or not. */
export async function serverPeerMessageStaged(recipientId: string, id: string) {
	const result = await database().query(
		"select 1 from agent_peer_inbox where recipient_id=$1 and id=$2",
		[recipientId, id],
	);
	return (result.rowCount ?? 0) > 0;
}
export async function removePendingServerPeerMessage(
	recipientId: string,
	id: string,
) {
	await database().query(
		"delete from agent_peer_inbox where recipient_id=$1 and id=$2 and not accepted",
		[recipientId, id],
	);
}

export async function acknowledgeServerPeerMessage(
	recipientId: string,
	id: string,
) {
	await database().query(
		"update agent_peer_inbox set accepted=true where recipient_id=$1 and id=$2",
		[recipientId, id],
	);
}
/**
 * Persist the real model history before acknowledging input; retries cannot
 * silently discard it. A runtime notice already in the history is not added
 * again; a user's queued message is matched by its timeline id instead
 * (`delivered`), since a person may well send the same words twice. The
 * checkpoint receives the timeline messages this delivery adds.
 */
export async function injectServerPeerMessages(
	recipientId: string,
	history: ModelMessage[],
	checkpoint: (
		messages: ModelMessage[],
		delivered: readonly UserMessageItem[],
	) => Promise<void>,
	delivered: (messageId: string) => boolean = () => false,
	/** Told when the read found the chat's setup catch-up ready (setup-catch-up.ts); it is never injected. */
	onSetupCatchUp?: () => void,
) {
	if (!peerInboxMayHaveMessages(recipientId)) return history;
	const result = await database().query<{
		id: string;
		message: string;
		queued_send: { item: UserMessageItem; released?: boolean } | null;
	}>(
		"select id,message,queued_send from agent_peer_inbox where recipient_id=$1 and not accepted order by created_at,id limit 16",
		[recipientId],
	);
	if (!result.rows.length) return history;
	const catchUp = result.rows.some((row) => isSetupCatchUpRow(row.id));
	if (catchUp) onSetupCatchUp?.();
	// A queued follow-up stays editable until Send. The turn's end takes it
	// whether or not Send was pressed; this step does not.
	const delivering = result.rows.filter(
		(row) =>
			!isSetupCatchUpRow(row.id) &&
			!(row.queued_send?.item && row.queued_send.released === false),
	);
	if (!delivering.length) return history;
	const injected = [...history];
	const users: UserMessageItem[] = [];
	for (const row of delivering) {
		const item = row.queued_send?.item;
		if (item) {
			if (delivered(item.id)) continue;
			users.push(item);
			injected.push({ role: "user", content: row.message });
		} else if (
			!injected.some(
				(message) => message.role === "user" && message.content === row.message,
			)
		) {
			injected.push({ role: "user", content: row.message });
			// Steering shows in the subagent's transcript where it arrived.
			const steering = steeringTimelineItem(row.id, row.message);
			if (steering && !delivered(steering.id)) users.push(steering);
		}
	}
	await checkpoint(injected, users);
	await database().query(
		"update agent_peer_inbox set accepted=true where recipient_id=$1 and id=any($2::text[])",
		[recipientId, delivering.map((row) => row.id)],
	);
	// A heartbeat that read the inbox before this must not report these as
	// still waiting (queuedMessageSentNow would restart the step for nothing).
	forgetPeerInboxObservation(recipientId);
	return injected;
}

/** A delivered steering message as its recipient's timeline item; null for other notices. */
export function steeringTimelineItem(
	inboxId: string,
	message: string,
): UserMessageItem | null {
	return parseSteering(message)
		? {
				kind: "userMessage",
				id: SessionItemId(`steer:${inboxId}`),
				text: message,
			}
		: null;
}

/** A steering message waiting in a subagent's mailbox. */
export type PendingSteering = {
	readonly id: string;
	readonly recipientId: string;
	readonly message: string;
};

/** Steering staged for these subagents that no model step has taken yet, oldest first. */
export async function pendingSteeringMessages(
	recipientIds: readonly string[],
): Promise<PendingSteering[]> {
	if (!recipientIds.length) return [];
	const result = await database().query<{
		id: string;
		recipient_id: string;
		message: string;
	}>(
		"select id,recipient_id,message from agent_peer_inbox where recipient_id=any($1::uuid[]) and not accepted and queued_send is null and message like 'Message from %' order by created_at,id",
		[recipientIds],
	);
	return result.rows.map((row) => ({
		id: row.id,
		recipientId: row.recipient_id,
		message: row.message,
	}));
}
