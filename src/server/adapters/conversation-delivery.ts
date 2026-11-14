import { randomUUID } from "node:crypto";
import { recordedContextUsage } from "#/domain/api-progress";
import { childTaskPublicItems } from "#/domain/child-task-activity";
import {
	type ConversationDelta,
	type ConversationSnapshot,
	type ConversationUpdate,
	isConversationDelta,
} from "#/domain/conversation-delivery";
import {
	type SessionItem,
	sessionItemsFromUnknown,
	type UserMessageItem,
	withQueuedUserMessages,
} from "#/domain/session-item";
import { SNAPSHOT_TURNS } from "#/domain/transcript-page";
import { database } from "./database";
import { queuedTimelineItemSql } from "./queued-user-messages";
import {
	ITEM_COUNT_SQL,
	LATEST_CONTEXT_USAGE_SQL,
	LATEST_PAGE_HAS_OLDER_SQL,
	LATEST_PAGE_ITEMS_SQL,
	latestPageJoin,
	latestPageRowsSinceSql,
} from "./transcript-page-sql";

/**
 * A snapshot carries the chat's last few turns (SNAPSHOT_TURNS), not the
 * whole chat or a full page. Given the items revision the receiver holds
 * (`delta_base.rev`, null when unknown), it carries only that page's rows
 * written since (agent_session_item.rev) and the page's bounds instead: a
 * delta. A base newer than the chat (a restored database) is unknown.
 */
const UPDATE_COLUMNS = `s.user_id,s.id session_id,s.items_rev::text items_rev,page.first,delta_base.rev::text base_items_rev,
	 case when delta_base.rev is null then ${LATEST_PAGE_ITEMS_SQL} end as items,
	 case when delta_base.rev is not null then ${latestPageRowsSinceSql("delta_base.rev")} end as changed,
	 case when delta_base.rev is not null then ${ITEM_COUNT_SQL} end as item_count,
	 ${LATEST_PAGE_HAS_OLDER_SQL} as has_older_items,${LATEST_CONTEXT_USAGE_SQL} as context_usage,s.turn_status,
	 (select jsonb_agg(${queuedTimelineItemSql} order by q.created_at,q.id) from agent_peer_inbox q
	  where q.recipient_id=s.id and not q.accepted and q.queued_send is not null) as queued`;
const updateJoins = (base: string) =>
	`${latestPageJoin(SNAPSHOT_TURNS)}
	 cross join lateral (select case when ${base} <= s.items_rev then ${base} end as rev) delta_base`;

type DeliveryRow = {
	user_id: string;
	session_id: string;
	revision: string;
	items_rev: string;
	first: number;
	base_items_rev: string | null;
	/** The whole latest page (a full snapshot). */
	items: unknown[] | null;
	/** The page's rows written after base_items_rev (a delta). */
	changed: { position: number; item: unknown }[] | null;
	item_count: number | null;
	has_older_items: boolean;
	context_usage?: ReturnType<typeof recordedContextUsage> | null;
	/** Messages still waiting behind the running turn, oldest first. */
	queued: UserMessageItem[] | null;
	turn_status: ConversationSnapshot["progress"]["turnStatus"];
};

/** One stored item as the view shows it; null when the view drops it. */
function publicItem(stored: unknown): SessionItem | null {
	return childTaskPublicItems(sessionItemsFromUnknown([stored]))[0] ?? null;
}

function snapshot(row: DeliveryRow): ConversationSnapshot {
	const stored = Array.isArray(row.items) ? row.items : [];
	const first = Number(row.first);
	const shown: SessionItem[] = [];
	const hidden: number[] = [];
	stored.forEach((entry, index) => {
		const item = publicItem(entry);
		if (item) shown.push(item);
		else hidden.push(first + index);
	});
	const items = withQueuedUserMessages(shown, row.queued ?? []);
	return {
		userId: row.user_id,
		sessionId: row.session_id,
		revision: String(row.revision),
		progress: {
			sessionId: row.session_id,
			items,
			hasOlderItems: row.has_older_items,
			turnStatus: row.turn_status,
			usage: row.context_usage ?? recordedContextUsage(items),
		},
		window: {
			itemsRev: String(row.items_rev),
			first,
			end: first + stored.length,
			hidden,
		},
	};
}

function update(row: DeliveryRow): ConversationUpdate {
	if (row.base_items_rev === null || !Array.isArray(row.changed))
		return snapshot(row);
	const queued = withQueuedUserMessages([], row.queued ?? []);
	const first = Number(row.first);
	const delta: ConversationDelta = {
		kind: "delta",
		userId: row.user_id,
		sessionId: row.session_id,
		revision: String(row.revision),
		baseItemsRev: String(row.base_items_rev),
		window: {
			itemsRev: String(row.items_rev),
			first,
			end: Math.max(first, Number(row.item_count ?? 0)),
		},
		rows: row.changed.map((entry) => ({
			position: Number(entry.position),
			item: publicItem(entry.item),
		})),
		queued,
		hasOlderItems: row.has_older_items,
		turnStatus: row.turn_status,
	};
	// The stored usage covers every row; the page's own copy adds nothing to it.
	const usage = row.context_usage ?? recordedContextUsage(queued);
	return usage === undefined ? delta : { ...delta, usage };
}

/** The chat's full snapshot: a first load, a reconnect, or a receiver that lost track. */
export async function conversationSnapshot(userId: string, sessionId: string) {
	const result = await database().query<DeliveryRow>(
		`select d.revision::text,${UPDATE_COLUMNS}
	 from agent_session s join conversation_delivery d on d.session_id=s.id ${updateJoins("null::bigint")}
	 where s.id=$1 and s.user_id=$2`,
		[sessionId, userId],
	);
	return result.rows[0] ? snapshot(result.rows[0]) : null;
}

/** What changed since the receiver's items revision `since` (a full snapshot when it is unusable). */
export async function conversationUpdateSince(
	userId: string,
	sessionId: string,
	since: string,
) {
	const result = await database().query<DeliveryRow>(
		`select d.revision::text,${UPDATE_COLUMNS}
	 from agent_session s join conversation_delivery d on d.session_id=s.id ${updateJoins("$3::bigint")}
	 where s.id=$1 and s.user_id=$2`,
		[sessionId, userId, since],
	);
	return result.rows[0] ? update(result.rows[0]) : null;
}

/**
 * Release the PG connection before WAN delivery. Failed rooms receive their own retry deadline.
 * A room that took the last delivery is at its items revision (delivered_items_rev): it is
 * sent a delta against it; one that is not answers so and is sent a full snapshot.
 */
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
	 order by retry_at for update skip locked limit $2) returning session_id,revision,delivered_items_rev)
	 select c.revision::text,${UPDATE_COLUMNS}
	 from claimed c join agent_session s on s.id=c.session_id ${updateJoins("c.delivered_items_rev")}`,
		[leaseId, limit, sessionId ?? null],
	);
	return result.rows.map((row) => ({ update: update(row), leaseId }));
}
export async function settleConversationDelivery(
	input: { update: ConversationUpdate; leaseId: string },
	delivered: boolean,
) {
	const itemsRev = isConversationDelta(input.update)
		? input.update.window.itemsRev
		: (input.update.window?.itemsRev ?? null);
	await database().query(
		`update conversation_delivery set
	 delivered_revision=case when $4 then greatest(delivered_revision,$3::bigint) else delivered_revision end,
	 delivered_items_rev=case when $4 and $3::bigint >= delivered_revision then $5::bigint else delivered_items_rev end,
	 attempts=case when $4 then 0 else attempts+1 end,
	 retry_at=case when $4 then now() else now()+least(60,power(2,least(attempts,6))) * interval '1 second' end,
	 lease_id=null,lease_until=null where session_id=$1 and lease_id=$2`,
		[
			input.update.sessionId,
			input.leaseId,
			input.update.revision,
			delivered,
			itemsRev,
		],
	);
}
