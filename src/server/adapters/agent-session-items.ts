import { database } from "./database";

/**
 * The transcripts of the user's chats `sessionIds`, by chat id, each in
 * transcript order. Read from agent_session_item (kept in step with
 * agent_session.items by a trigger), one aggregated row per chat. A chat
 * with no rows is absent from the map.
 */
export async function transcriptItemsForOwner(
	userId: string,
	sessionIds: readonly string[],
): Promise<Map<string, unknown[]>> {
	if (sessionIds.length === 0) return new Map();
	const result = await database().query<{
		session_id: string;
		items: unknown[];
	}>(
		`select i.session_id, jsonb_agg(i.item order by i.position) as items
		 from agent_session_item i join agent_session s on s.id=i.session_id and s.user_id=$1
		 where i.session_id = any($2::uuid[])
		 group by i.session_id`,
		[userId, [...sessionIds]],
	);
	return new Map(result.rows.map((row) => [row.session_id, row.items]));
}
