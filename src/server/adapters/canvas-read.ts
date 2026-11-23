import { database } from "./database";

/** Most characters of the latest feedback message a canvas read carries. */
export const CANVAS_FEEDBACK_LIMIT = 4_000;

/** One canvas revision read whole, by chat and title. */
export type CanvasRead = {
	readonly itemId: string;
	readonly title: string;
	readonly revision: number;
	readonly html: string;
	readonly path?: string;
	/** The highest revision of this title, which may be newer than the one read (its html was dropped by the chat's canvas budget). */
	readonly latestRevision: number;
	/**
	 * The newest "Canvas feedback on "<title>" …" message the person sent the
	 * chat (their pinned notes, at most CANVAS_FEEDBACK_LIMIT characters), if any.
	 */
	readonly feedback?: string;
};

/**
 * The latest revision of one canvas of one of the owner's chats, whole: ONE
 * item is read (the lazy whole-item read, sessionItemDetailForOwner, by
 * title instead of id: Y² knows a canvas by title). Latest means the highest
 * revision number of that title, as the canvas tool numbers them
 * (savedCanvasRevision); when that revision's html was dropped by the chat's
 * canvas budget the newest one that still has html stands in. With it, the
 * chat's newest feedback message on that canvas (the notes the person pinned
 * and sent). Null when the chat has no such canvas.
 */
export async function latestCanvasForOwner(
	userId: string,
	sessionId: string,
	title: string,
): Promise<CanvasRead | null> {
	const { rows } = await database().query<{
		item_id: string;
		title: string;
		revision: number;
		html: string;
		path: string | null;
		latest: number;
		feedback: string | null;
	}>(
		`/* latestCanvasForOwner */ select i.item_id, i.item->>'title' as title,
		   (i.item->>'revision')::int as revision, i.item->>'html' as html, i.item->>'path' as path,
		   (select max((c.item->>'revision')::int) from agent_session_item c
		     where c.session_id=$2 and c.kind='canvas' and lower(c.item->>'title')=lower($3)) as latest,
		   (select left(f.item->>'text', $4) from agent_session_item f
		     where f.session_id=$2 and f.kind='userMessage'
		       and left(f.item->>'text', length(i.item->>'title') + 21) = 'Canvas feedback on "' || (i.item->>'title') || '"'
		     order by f.position desc limit 1) as feedback
		 from agent_session_item i join agent_session s on s.id=i.session_id and s.user_id=$1
		 where i.session_id=$2 and i.kind='canvas' and lower(i.item->>'title')=lower($3)
		   and i.item->>'html' is not null
		 order by (i.item->>'revision')::int desc, i.position desc limit 1`,
		[userId, sessionId, title, CANVAS_FEEDBACK_LIMIT],
	);
	const row = rows[0];
	if (!row) return null;
	return {
		itemId: row.item_id,
		title: row.title,
		revision: row.revision,
		html: row.html,
		...(row.path ? { path: row.path } : {}),
		latestRevision: row.latest ?? row.revision,
		...(row.feedback ? { feedback: row.feedback } : {}),
	};
}
