import { database } from "./database";

/**
 * The highest revision a canvas with this title has anywhere in the chat
 * (0 when new). A turn holds only its own items in memory, so numbering
 * from those restarted every canvas at revision 1 on each new turn.
 */
export async function savedCanvasRevision(
	sessionId: string,
	title: string,
): Promise<number> {
	const { rows } = await database().query<{ latest: number | null }>(
		`select max((item->>'revision')::int) as latest
		 from agent_session_item
		 where session_id=$1 and kind='canvas' and item->>'title'=$2`,
		[sessionId, title],
	);
	return rows[0]?.latest ?? 0;
}
