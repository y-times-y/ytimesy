import type { ModelMessage } from "ai";
import type { SessionItem } from "#/domain/session-item";
import { database } from "./database";

/**
 * A turn's model messages and only the chat's transcript rows written after
 * revision `itemsRev` (agent_session_item.rev), with the transcript's item
 * count: with a copy of the transcript at that revision, its whole history.
 * `wholeItems`: the turn keeps its items itself (the old shape; read it
 * whole). Null when the turn is not this lease's.
 */
export async function turnHistorySince(
	turnId: string,
	leaseId: string,
	itemsRev: string,
): Promise<{
	messages: ModelMessage[];
	wholeItems: boolean;
	itemsRev: string;
	count: number;
	changed: { position: number; item: SessionItem }[];
} | null> {
	const row = (
		await database().query<{
			messages: ModelMessage[];
			whole_items: boolean;
			items_rev: string;
			count: number;
			changed: { position: number; item: SessionItem }[];
		}>(
			`select t.messages, jsonb_typeof(t.items)='array' as whole_items, s.items_rev::text as items_rev,
			 (select coalesce(max(i.position)+1,0)::int from agent_session_item i where i.session_id=s.id) as count,
			 (select coalesce(jsonb_agg(jsonb_build_object('position',i.position,'item',i.item) order by i.position),'[]'::jsonb)
			  from agent_session_item i where i.session_id=s.id and i.rev > $3::bigint) as changed
			 from api_turn t join agent_session s on s.id=t.session_id where t.id=$1 and t.lease_id=$2`,
			[turnId, leaseId, itemsRev],
		)
	).rows[0];
	return row
		? {
				messages: row.messages,
				wholeItems: row.whole_items,
				itemsRev: row.items_rev,
				count: row.count,
				changed: row.changed,
			}
		: null;
}
