import type { ModelMessage } from "ai";
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
/** Persist the real model history before acknowledging input; retries cannot silently discard it. */
export async function injectServerPeerMessages(
	recipientId: string,
	history: ModelMessage[],
	checkpoint: (messages: ModelMessage[]) => Promise<void>,
) {
	const result = await database().query<{ id: string; message: string }>(
		"select id,message from agent_peer_inbox where recipient_id=$1 and not accepted order by created_at,id limit 16",
		[recipientId],
	);
	if (!result.rows.length) return history;
	const injected = [...history];
	for (const row of result.rows)
		if (
			!injected.some(
				(item) => item.role === "user" && item.content === row.message,
			)
		)
			injected.push({ role: "user", content: row.message });
	await checkpoint(injected);
	await database().query(
		"update agent_peer_inbox set accepted=true where recipient_id=$1 and id=any($2::text[])",
		[recipientId, result.rows.map((row) => row.id)],
	);
	return injected;
}
