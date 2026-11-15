import type { ModelMessage } from "ai";
import type { SessionItem } from "#/domain/session-item";
import { database } from "./database";

/**
 * A turn's model messages and only the chat's transcript rows written after
 * revision `itemsRev` (agent_session_item.rev), with the transcript's item
 * count: with a copy of the transcript at that revision, its whole history.
 * `wholeItems`: the turn keeps its items itself (the old shape; read it
 * whole). With `messagesCopy`, the history of the turn this one continues at
 * that row version (api_turn.base_*): when it is the one it continued,
 * `messages` are only those after it (`messagesAfter`, the copy's count).
 * Null when the turn is not this lease's.
 */
export async function turnHistorySince(
	turnId: string,
	leaseId: string,
	itemsRev: string,
	messagesCopy?: { readonly turnId: string; readonly version: string },
): Promise<{
	messages: ModelMessage[];
	/** `messages` follow this many messages of the copy (null: they are the whole history). */
	messagesAfter: number | null;
	wholeItems: boolean;
	itemsRev: string;
	count: number;
	changed: { position: number; item: SessionItem }[];
} | null> {
	const row = (
		await database().query<{
			messages: ModelMessage[];
			messages_after: number | null;
			whole_items: boolean;
			items_rev: string;
			count: number;
			changed: { position: number; item: SessionItem }[];
		}>(
			`with c as (select t.base_count as after from api_turn t
			  where t.id=$1 and t.base_turn_id::text=$4::text and t.base_version=$5::text and t.base_count is not null)
			 select case when exists(select 1 from c) then (select coalesce(jsonb_agg(e order by n),'[]'::jsonb)
			   from jsonb_array_elements(t.messages) with ordinality x(e,n) where n > (select after from c)) else t.messages end as messages,
			 (select after from c) as messages_after,
			 jsonb_typeof(t.items)='array' as whole_items, s.items_rev::text as items_rev,
			 (select coalesce(max(i.position)+1,0)::int from agent_session_item i where i.session_id=s.id) as count,
			 (select coalesce(jsonb_agg(jsonb_build_object('position',i.position,'item',i.item) order by i.position),'[]'::jsonb)
			  from agent_session_item i where i.session_id=s.id and i.rev > $3::bigint) as changed
			 from api_turn t join agent_session s on s.id=t.session_id where t.id=$1 and t.lease_id=$2`,
			[
				turnId,
				leaseId,
				itemsRev,
				messagesCopy?.turnId ?? null,
				messagesCopy?.version ?? null,
			],
		)
	).rows[0];
	return row
		? {
				messages: row.messages,
				messagesAfter: row.messages_after,
				wholeItems: row.whole_items,
				itemsRev: row.items_rev,
				count: row.count,
				changed: row.changed,
			}
		: null;
}
