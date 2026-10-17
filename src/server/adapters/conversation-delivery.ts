import { randomUUID } from "node:crypto";
import { recordedContextUsage } from "#/domain/api-progress";
import { childTaskPublicItems } from "#/domain/child-task-activity";
import type { ConversationSnapshot } from "#/domain/conversation-delivery";
import {
	sessionItemsFromUnknown,
	type UserMessageItem,
	withQueuedUserMessages,
} from "#/domain/session-item";
import { database } from "./database";

type DeliveryRow = {
	user_id: string;
	session_id: string;
	revision: string;
	items: unknown[];
	/** Messages still waiting behind the running turn, oldest first. */
	queued: UserMessageItem[] | null;
	turn_status: ConversationSnapshot["progress"]["turnStatus"];
};
function snapshot(row: DeliveryRow): ConversationSnapshot {
	const items = withQueuedUserMessages(
		childTaskPublicItems(sessionItemsFromUnknown(row.items)),
		row.queued ?? [],
	);
	return {
		userId: row.user_id,
		sessionId: row.session_id,
		revision: String(row.revision),
		progress: {
			sessionId: row.session_id,
			items,
			turnStatus: row.turn_status,
			usage: recordedContextUsage(items),
		},
	};
}
export async function conversationSnapshot(userId: string, sessionId: string) {
	const result = await database().query<DeliveryRow>(
		`select s.user_id,s.id session_id,d.revision::text,s.items,s.turn_status,
	 (select jsonb_agg(q.queued_send->'item' order by q.created_at,q.id) from agent_peer_inbox q
	  where q.recipient_id=s.id and not q.accepted and q.queued_send is not null) as queued
	 from agent_session s join conversation_delivery d on d.session_id=s.id
	 where s.id=$1 and s.user_id=$2`,
		[sessionId, userId],
	);
	return result.rows[0] ? snapshot(result.rows[0]) : null;
}

/** Release the PG connection before WAN delivery. Failed rooms receive their own retry deadline. */
export async function claimConversationDeliveries(
	limit = 16,
	sessionId?: string,
) {
	const leaseId = randomUUID();
	const result = await database().query<DeliveryRow>(
		`with claimed as (
	 update conversation_delivery set lease_id=$1,lease_until=now()+interval '15 seconds'
	 where session_id in(select session_id from conversation_delivery
	 where revision>delivered_revision and retry_at<=now() and (lease_until is null or lease_until<now())
	 and ($3::uuid is null or session_id=$3::uuid)
	 order by retry_at for update skip locked limit $2) returning session_id,revision)
	 select s.user_id,s.id session_id,c.revision::text,s.items,s.turn_status,
	 (select jsonb_agg(q.queued_send->'item' order by q.created_at,q.id) from agent_peer_inbox q
	  where q.recipient_id=s.id and not q.accepted and q.queued_send is not null) as queued
	 from claimed c join agent_session s on s.id=c.session_id`,
		[leaseId, limit, sessionId ?? null],
	);
	return result.rows.map((row) => ({ snapshot: snapshot(row), leaseId }));
}
export async function settleConversationDelivery(
	input: { snapshot: ConversationSnapshot; leaseId: string },
	delivered: boolean,
) {
	await database().query(
		`update conversation_delivery set
	 delivered_revision=case when $4 then greatest(delivered_revision,$3::bigint) else delivered_revision end,
	 attempts=case when $4 then 0 else attempts+1 end,
	 retry_at=case when $4 then now() else now()+least(60,power(2,least(attempts,6))) * interval '1 second' end,
	 lease_id=null,lease_until=null where session_id=$1 and lease_id=$2`,
		[
			input.snapshot.sessionId,
			input.leaseId,
			input.snapshot.revision,
			delivered,
		],
	);
}
