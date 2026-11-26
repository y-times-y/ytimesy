import { database } from "./database";

/**
 * What a chat's object needs to tell its project's crew (y-squared-crew.ts),
 * read by the chat alone: never by its turn's executor or lease. A box turn
 * (executor `node`) and a turn a box claimed and handed back have no
 * durable-object lease to match, and the lookup by turn left them with no
 * scope, so Y² never heard of threads whose turns ran on boxes.
 * Helper chats (any parent) are not threads: they never join the crew.
 * `title` is the chat's own (the sidebar's) title, for the start note of a
 * turn whose object holds no transcript yet.
 */
export type ChatCrewScope = {
	readonly projectId: string | null;
	readonly yEnabled: boolean;
	readonly ySquaredId: string | null;
	readonly title: string | null;
};

export async function readChatCrewScope(
	userId: string,
	sessionId: string,
): Promise<ChatCrewScope | null> {
	const result = await database().query<ChatCrewScope>(
		`select s.project_id as "projectId",
		   (coalesce(p.y_enabled,false) and s.parent_session_id is null
		     and s.chat_role is distinct from 'canary') as "yEnabled",
		   case when p.y_enabled and s.parent_session_id is null
		     and s.chat_role is distinct from 'canary' then (select y.id from agent_session y
		     where y.user_id=s.user_id and y.project_id=s.project_id
		       and y.chat_role='y2' and y.archived_at is null limit 1) end as "ySquaredId",
		   s.title
		 from agent_session s
		 left join project p on p.id=s.project_id and p.user_id=s.user_id
		 where s.id=$1 and s.user_id=$2`,
		[sessionId, userId],
	);
	return result.rows[0] ?? null;
}

/**
 * Real progress of threads the crew believes are working, from the turns
 * themselves (never from what a chat's object happened to tell the crew):
 * `progressAt` is the newest of the active turn's last write (a checkpoint
 * after every model call and tool result, or a progress publish; from a
 * Durable Object or a box alike) and its last lease renewal (a box renews
 * every 10-30 s while a long tool call or a Claude run works). `active` is
 * false when the chat has no queued or running turn: the crew's "working"
 * then only means its settle note was lost, and `turnStatus` is how it ended.
 */
export type ThreadProgress = {
	readonly sessionId: string;
	readonly active: boolean;
	readonly queued: boolean;
	readonly progressAt: number | null;
	readonly turnStatus: string | null;
};

export async function readThreadProgress(
	userId: string,
	sessionIds: readonly string[],
): Promise<ThreadProgress[]> {
	if (!sessionIds.length) return [];
	const result = await database().query<{
		session_id: string;
		turn_status: string | null;
		running: boolean;
		queued: boolean;
		progress_at: Date | string | null;
	}>(
		`select s.id::text as session_id, s.turn_status,
		   exists(select 1 from api_turn t where t.session_id=s.id and t.state='running') as running,
		   exists(select 1 from api_turn t where t.session_id=s.id and t.state='queued') as queued,
		   (select max(greatest(t.updated_at, coalesce(t.heartbeat_at, t.updated_at)))
		     from api_turn t where t.session_id=s.id and t.state in ('queued','running')) as progress_at
		 from agent_session s
		 where s.user_id=$1 and s.id::text = any($2::text[])`,
		[userId, [...sessionIds]],
	);
	return result.rows.map((row) => ({
		sessionId: row.session_id,
		active: row.running || row.queued,
		queued: row.queued && !row.running,
		progressAt: row.progress_at ? new Date(row.progress_at).getTime() : null,
		turnStatus: row.turn_status,
	}));
}
