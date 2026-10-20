import type { ModelMessage } from "ai";
import type { UserMessageItem } from "#/domain/session-item";
import { database } from "./database";

export async function stageServerPeerMessage(
	recipientId: string,
	id: string,
	message: string,
) {
	await database().query(
		"insert into agent_peer_inbox(id,recipient_id,message) values($1,$2,$3) on conflict(id) do nothing",
		[id, recipientId, message],
	);
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
) {
	const result = await database().query<{
		id: string;
		message: string;
		queued_send: { item: UserMessageItem } | null;
	}>(
		"select id,message,queued_send from agent_peer_inbox where recipient_id=$1 and not accepted order by created_at,id limit 16",
		[recipientId],
	);
	if (!result.rows.length) return history;
	const injected = [...history];
	const users: UserMessageItem[] = [];
	for (const row of result.rows) {
		const item = row.queued_send?.item;
		if (item) {
			if (delivered(item.id)) continue;
			users.push(item);
			injected.push({ role: "user", content: row.message });
		} else if (
			!injected.some(
				(message) => message.role === "user" && message.content === row.message,
			)
		)
			injected.push({ role: "user", content: row.message });
	}
	await checkpoint(injected, users);
	await database().query(
		"update agent_peer_inbox set accepted=true where recipient_id=$1 and id=any($2::text[])",
		[recipientId, result.rows.map((row) => row.id)],
	);
	return injected;
}
