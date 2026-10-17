import type { AgentProviderId } from "#/domain/agent-provider";
import type { UserMessageItem } from "#/domain/session-item";
import { wakeConversationProgress } from "./conversation-progress-wake";
import { database } from "./database";

/** A composer send waiting in the chat's inbox while a turn runs. */
export type QueuedUserSend = {
	/** The timeline message, with its attachments already in private storage. */
	readonly item: UserMessageItem;
	/** What the model reads for it (the text plus its attachment note). */
	readonly message: string;
	/** The route and settings a turn it starts uses. */
	readonly harnessId: AgentProviderId;
	readonly modelId: string;
	readonly variant?: string;
	readonly speed?: "standard" | "fast" | "ultrafast";
	readonly fast?: boolean;
};

const inboxId = (messageId: string) => `queued-user:${messageId}`;

/**
 * Queues the send only while the chat's turn is running. The session row lock
 * orders it against the turn's end: a turn that already ended returns
 * "not-running" (the caller starts a turn), and one that ends after this
 * commits finds the message waiting. Touching `items` republishes the chat.
 */
export async function queueUserMessageWhileRunning(
	userId: string,
	sessionId: string,
	send: QueuedUserSend,
): Promise<"queued" | "not-running"> {
	const { message, ...stored } = send;
	const result = await database().query<{ running: number }>(
		`with s as (update agent_session set items=items where id=$1 and user_id=$2 and turn_status='running' returning id),
		 queued as (insert into agent_peer_inbox(id,recipient_id,message,queued_send)
		  select $3,s.id,$4,$5::jsonb from s on conflict(id) do nothing returning id)
		 select (select count(*) from s)::int as running`,
		[sessionId, userId, inboxId(send.item.id), message, JSON.stringify(stored)],
	);
	if (!result.rows[0]?.running) return "not-running";
	await wakeConversationProgress();
	return "queued";
}

/** The chat's waiting messages, oldest first, for its public timeline. */
export async function queuedUserMessageItems(
	sessionId: string,
): Promise<UserMessageItem[]> {
	const result = await database().query<{ item: UserMessageItem }>(
		`select queued_send->'item' as item from agent_peer_inbox
		 where recipient_id=$1 and not accepted and queued_send is not null order by created_at,id`,
		[sessionId],
	);
	return result.rows.map((row) => row.item);
}

/** Only a message no step has taken yet can be removed. */
export async function removeQueuedUserMessage(
	userId: string,
	sessionId: string,
	messageId: string,
): Promise<boolean> {
	const result = await database().query(
		`with removed as (delete from agent_peer_inbox q using agent_session s
		  where q.id=$3 and q.recipient_id=s.id and s.id=$1 and s.user_id=$2
		  and not q.accepted and q.queued_send is not null returning q.recipient_id)
		 update agent_session set items=items where id in (select recipient_id from removed) returning id`,
		[sessionId, userId, inboxId(messageId)],
	);
	if (!result.rowCount) return false;
	await wakeConversationProgress();
	return true;
}

/**
 * Takes the oldest waiting message once the chat has no running turn, so it
 * can start the next one. Racing callers take it at most once.
 */
export async function takeNextQueuedUserMessage(
	userId: string,
	sessionId: string,
): Promise<QueuedUserSend | null> {
	const result = await database().query<{
		message: string;
		queued_send: Omit<QueuedUserSend, "message">;
	}>(
		`delete from agent_peer_inbox where id=(
		  select q.id from agent_peer_inbox q join agent_session s on s.id=q.recipient_id
		  where q.recipient_id=$1 and s.user_id=$2 and s.turn_status<>'running'
		  and not q.accepted and q.queued_send is not null
		  order by q.created_at,q.id limit 1 for update of q skip locked)
		 returning message,queued_send`,
		[sessionId, userId],
	);
	const row = result.rows[0];
	return row ? { ...row.queued_send, message: row.message } : null;
}

/** A taken message whose turn could not start goes back first in line. */
export async function restoreQueuedUserMessage(
	sessionId: string,
	send: QueuedUserSend,
) {
	const { message, ...stored } = send;
	await database().query(
		`with restored as (insert into agent_peer_inbox(id,recipient_id,message,queued_send,created_at)
		  values($1,$2,$3,$4::jsonb,'-infinity') on conflict(id) do nothing returning recipient_id)
		 update agent_session set items=items where id in (select recipient_id from restored)`,
		[inboxId(send.item.id), sessionId, message, JSON.stringify(stored)],
	);
	await wakeConversationProgress();
}
