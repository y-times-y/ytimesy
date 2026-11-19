import { canvasDescription, canvasSizeKb } from "#/domain/canvas-text";
import type { ThreadCanvas, ThreadOutcomeItem } from "#/domain/thread-outcome";
import { database } from "./database";

/** Rows read from the final turn at most (its messages, plan, questions, error). */
const FINAL_TURN_ROW_LIMIT = 60;
const CANVAS_LIMIT = 6;
/**
 * The most characters of one canvas's document that leave the database to
 * describe it. The size and the images flag are computed over the whole
 * document in SQL; base64 data: URIs are cut out before this window, so it
 * reaches the visible text of a document with inline images.
 */
export const CANVAS_DESCRIBE_CHARS = 24_000;

/**
 * What one of the user's chats produced in its final turn, for Y²'s `thread`
 * tool: the turn's agent messages, plan, questions and error (the rows of
 * those kinds from the last turn start on), and the chat's canvases without
 * their documents (the latest revision of each title: its size and images
 * flag from the whole document in SQL, a short description from the first
 * `CANVAS_DESCRIBE_CHARS` characters with data: URIs cut out). Two small reads by chat id, only when Y² asks. When the
 * final turn said nothing (a wake or an error), the chat's last agent message
 * stands in.
 */
export async function threadOutcomeForOwner(
	userId: string,
	sessionId: string,
): Promise<{
	items: ThreadOutcomeItem[];
	canvases: ThreadCanvas[];
} | null> {
	const final = await database().query<{ item: ThreadOutcomeItem }>(
		`select i.item from agent_session_item i
		 join agent_session s on s.id=i.session_id and s.user_id=$1
		 where i.session_id=$2
		   and i.position >= coalesce((select max(t.position) from agent_session_item t
		     where t.session_id=$2 and t.starts_turn),0)
		   and i.kind in ('agentMessage','planProposal','userQuestion','error')
		 order by i.position desc limit ${FINAL_TURN_ROW_LIMIT}`,
		[userId, sessionId],
	);
	const items = final.rows.map((row) => row.item).reverse();
	if (!items.some((item) => item.kind === "agentMessage")) {
		const earlier = await database().query<{ item: ThreadOutcomeItem }>(
			`select i.item from agent_session_item i
			 join agent_session s on s.id=i.session_id and s.user_id=$1
			 where i.session_id=$2 and i.kind='agentMessage'
			 order by i.position desc limit 1`,
			[userId, sessionId],
		);
		if (earlier.rows[0]) items.unshift(earlier.rows[0].item);
	}
	const canvases = await database().query<{
		title: string;
		revision: number;
		size: number;
		has_images: boolean | null;
		head: string;
	}>(
		`select title, revision, size, has_images, head from (
		   select distinct on (i.item->>'title') i.item->>'title' as title,
		     (i.item->>'revision')::int as revision, i.position,
		     coalesce(length(i.item->>'html'),0) as size,
		     (i.item->>'html') ~* '<img\\y|<picture\\y|data:image/' as has_images,
		     left(regexp_replace(coalesce(i.item->>'html',''), 'data:[^"''[:space:])]{200,}', 'data:', 'g'), ${CANVAS_DESCRIBE_CHARS}) as head
		   from agent_session_item i
		   join agent_session s on s.id=i.session_id and s.user_id=$1
		   where i.session_id=$2 and i.kind='canvas'
		   order by i.item->>'title', (i.item->>'revision')::int desc, i.position desc
		 ) latest order by position desc limit ${CANVAS_LIMIT}`,
		[userId, sessionId],
	);
	return {
		items,
		canvases: canvases.rows
			.filter((row) => row.title)
			.reverse()
			.map(
				(row): ThreadCanvas => ({
					title: row.title,
					revision: row.revision,
					sizeKb: canvasSizeKb(row.size),
					hasImages: row.has_images === true,
					description: canvasDescription(row.head),
				}),
			),
	};
}
