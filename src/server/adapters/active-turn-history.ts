import type { ModelMessage } from "ai";
import type { SessionItem } from "#/domain/session-item";
import { database } from "./database";

export type SavedModelHistory = {
	readonly turnId: string;
	readonly version: string;
	readonly settled: boolean;
	readonly messages: ModelMessage[];
};

/**
 * A modern turn's working transcript, starting at its own user message. Older
 * visible turns stay in Postgres and are never returned by this query. Model
 * history is independent: a matching local predecessor supplies its prefix.
 * A missing marker or a stale lease returns null, never the whole transcript.
 */
export async function activeTurnHistory(
	turnId: string,
	leaseId: string,
	from: string,
	copy: SavedModelHistory | null = null,
): Promise<{
	messages: ModelMessage[];
	items: SessionItem[];
	items_rev: string;
} | null> {
	const row = (
		await database().query<{
			messages: ModelMessage[];
			messages_after: number | null;
			items: SessionItem[];
			items_rev: string;
		}>(
			`with base as (select t.base_count as after from api_turn t
			 where t.id=$1 and t.base_turn_id::text=$4 and t.base_count=$7::int
			 and (t.base_version=$5 or $6::boolean))
			 select case when exists(select 1 from base)
			 then (select coalesce(jsonb_agg(e order by n),'[]'::jsonb)
			  from jsonb_array_elements(t.messages) with ordinality x(e,n)
			  where n > (select after from base)) else t.messages end as messages,
			 (select after from base) as messages_after,
			 (select coalesce(jsonb_agg(i.item order by i.position),'[]'::jsonb)
			  from agent_session_item i where i.session_id=s.id and i.position>=anchor.position) as items,
			 s.items_rev::text as items_rev
			 from api_turn t join agent_session s on s.id=t.session_id
			 cross join lateral (select i.position from agent_session_item i
			  where i.session_id=s.id and i.item_id=$3 order by i.position desc limit 1) anchor
			 where t.id=$1 and t.lease_id=$2 and t.items->>'from'=$3`,
			[
				turnId,
				leaseId,
				from,
				copy?.turnId ?? null,
				copy?.version ?? null,
				copy?.settled ?? false,
				copy?.messages.length ?? null,
			],
		)
	).rows[0];
	if (!row) return null;
	return {
		messages:
			row.messages_after !== null && copy
				? [...copy.messages, ...row.messages]
				: row.messages,
		items: row.items,
		items_rev: row.items_rev,
	};
}
