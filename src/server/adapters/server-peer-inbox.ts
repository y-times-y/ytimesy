import type { ModelMessage } from "ai";
import {
	PEER_INBOX_STEP_READ_LIMIT,
	type PeerInboxRow,
	planPeerInjection,
} from "#/domain/peer-inbox-injection";
import type { UserMessageItem } from "#/domain/session-item";
import { database } from "./database";
import {
	forgetPeerInboxObservation,
	peerInboxMayHaveMessages,
} from "./peer-inbox-observation";

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
 * The recipient's next pending inbox rows a step may take (at most
 * PEER_INBOX_STEP_READ_LIMIT, oldest first). A queued send still waiting for
 * Send (`released` false) is not read: no step takes it, so it must not use
 * up the limit and hide a released or steering row behind it. A row with no
 * `released` field (the old shape) is read as before.
 */
export async function readPeerInbox(
	recipientId: string,
): Promise<PeerInboxRow[]> {
	const result = await database().query<{
		id: string;
		message: string;
		queued_send: { item: UserMessageItem; released?: boolean } | null;
	}>(
		"select id,message,queued_send from agent_peer_inbox where recipient_id=$1 and not accepted and coalesce(queued_send->>'released','')<>'false' order by created_at,id limit $2",
		[recipientId, PEER_INBOX_STEP_READ_LIMIT],
	);
	return result.rows;
}

/** Marks inbox rows accepted, after a checkpoint saved what they delivered. */
export async function acceptPeerInbox(
	recipientId: string,
	ids: readonly string[],
) {
	await database().query(
		"update agent_peer_inbox set accepted=true where recipient_id=$1 and id=any($2::text[])",
		[recipientId, [...ids]],
	);
	// A heartbeat that read the inbox before this must not report these as
	// still waiting (queuedMessageSentNow would restart the step for nothing).
	forgetPeerInboxObservation(recipientId);
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
	/** Only the user's queued messages Send was pressed on (a Claude Code run's hooks). */
	sentUserMessagesOnly = false,
) {
	if (!peerInboxMayHaveMessages(recipientId)) return history;
	const rows = await readPeerInbox(recipientId);
	if (!rows.length) return history;
	const plan = planPeerInjection(rows, history, {
		delivered,
		sentUserMessagesOnly,
	});
	if (plan.catchUp) onSetupCatchUp?.();
	if (!plan.delivering.length) return history;
	const { injected, users } = plan;
	await checkpoint(injected, users);
	await acceptPeerInbox(recipientId, plan.delivering);
	return injected;
}

export { steeringTimelineItem } from "#/domain/peer-inbox-injection";

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
