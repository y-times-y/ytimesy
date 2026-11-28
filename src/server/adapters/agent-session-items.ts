import { database } from "./database";
import {
	boundedPageStartSql,
	type PageLimits,
	visibleTurnStartSql,
} from "./transcript-page-sql";

/** One page of a chat's stored transcript: its items and where they start. */
export type TranscriptPage = {
	/** The stored items from position `first` on, in transcript order. */
	readonly items: unknown[];
	/** The stored position of `items[0]` (positions are dense, from 0). */
	readonly first: number;
};

/**
 * The last page of each of the user's chats `sessionIds` (its last
 * `page.turns` turns, at most `page.bytes` and `page.items` of them, the
 * newest item always), or with `before` the page that ends just before that
 * stored position. Read from agent_session_item (kept in step with
 * agent_session.items by a trigger) and sliced by the database, so only the
 * pages leave it. A chat that is not the user's is absent from the map.
 */
export async function transcriptPagesForOwner(
	userId: string,
	sessionIds: readonly string[],
	page: PageLimits & { readonly turns: number; readonly before?: number },
): Promise<Map<string, TranscriptPage>> {
	if (sessionIds.length === 0) return new Map();
	if (!Number.isInteger(page.turns) || page.turns < 1)
		throw new Error("Invalid page.");
	const before = page.before;
	if (before !== undefined && (!Number.isInteger(before) || before < 0))
		throw new Error("Invalid page.");
	const stop = before === undefined ? undefined : "$3::int";
	const result = await database().query<{
		session_id: string;
		first: number;
		items: unknown[];
	}>(
		`select s.id as session_id, page.first,
		  (select coalesce(jsonb_agg(i.item order by i.position),'[]'::jsonb)
		   from agent_session_item i where i.session_id=s.id and i.position >= page.first
		   ${stop ? `and i.position < ${stop}` : ""}) as items
		 from agent_session s
		 cross join lateral (select case when count(*) < ${page.turns} then 0 else min(t.position) end as first
		  from (select i.position from agent_session_item i where i.session_id=s.id and ${visibleTurnStartSql("i")}
		   ${stop ? `and i.position < ${stop}` : ""}
		   order by i.position desc limit ${page.turns}) t) turn_page
		 cross join lateral (select ${boundedPageStartSql("s.id", "turn_page.first", stop, page)} as first) page
		 where s.user_id=$1 and s.id = any($2::uuid[])`,
		before === undefined
			? [userId, [...sessionIds]]
			: [userId, [...sessionIds], before],
	);
	return new Map(
		result.rows.map((row) => [
			row.session_id,
			{ items: row.items ?? [], first: Number(row.first) || 0 },
		]),
	);
}
