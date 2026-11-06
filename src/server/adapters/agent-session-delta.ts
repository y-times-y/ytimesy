import { database } from "./database";

/** What the browser holds of a chat's transcript: a read's revision and item count. */
export type TranscriptToken = {
	readonly rev: number;
	readonly count: number;
};

/**
 * The few rows before the first change that can anchor the browser's merge.
 * Only the head and tail of a long agent message travel: they decide whether
 * it is an internal notification (isInternalChildTaskMessage), which the view drops.
 */
const ANCHOR_ROWS = 4;

/**
 * The chat's transcript revision and item count (agent_session.items_rev and
 * agent_session_item, supabase/migrations/20261105100000_agent_session_items_rev.sql).
 * Read before a page, so the page is at least as new as the token. Null for a
 * chat that is not the user's.
 */
export async function transcriptTokenForOwner(
	userId: string,
	sessionId: string,
): Promise<TranscriptToken | null> {
	const result = await database().query<{ rev: string; count: number }>(
		`select s.items_rev as rev,
		  (select coalesce(max(i.position)+1,0)::int from agent_session_item i where i.session_id=s.id) as count
		 from agent_session s where s.id=$1 and s.user_id=$2`,
		[sessionId, userId],
	);
	const row = result.rows[0];
	return row ? { rev: Number(row.rev), count: row.count } : null;
}

export type TranscriptDelta = {
	readonly token: TranscriptToken;
	readonly projectId: string;
	readonly harness: string;
	readonly turnStatus: string;
	readonly workspaceId: string | null;
	readonly selectedBranch: string | null;
	readonly listedModelId: string | null;
	/** First position that may differ from the browser's copy; null when nothing does. */
	readonly fromPosition: number | null;
	/** Stored items from `fromPosition` to the end. */
	readonly tail: readonly unknown[];
	/** Rows just before `fromPosition`, nearest first. */
	readonly before: readonly {
		readonly id: string | null;
		readonly kind: string | null;
		readonly text: string | null;
	}[];
};

/**
 * What changed in the chat's transcript since the browser's `since`: every row
 * written after that revision, and the end of the transcript if it shrank.
 * One statement, so the revision, the count and the rows are one snapshot.
 * Null for a chat that is not the user's.
 */
export async function transcriptDeltaForOwner(
	userId: string,
	sessionId: string,
	since: TranscriptToken,
): Promise<TranscriptDelta | null> {
	const result = await database().query(
		`with s as (select items_rev, project_id, harness, turn_status, provider_ref,
		   coalesce(selected_branch, working_branch, task_branch) as selected_branch, listed_model_id
		  from agent_session where id=$1 and user_id=$2),
		 c as (select coalesce(max(i.position)+1,0)::int as n from agent_session_item i where i.session_id=$1),
		 ch as (select min(i.position) as f from agent_session_item i where i.session_id=$1 and i.rev > $3),
		 f as (select case when c.n < $4 then least(coalesce(ch.f, c.n), c.n) else ch.f end as at from c, ch)
		 select s.*, c.n as item_count, f.at as from_position,
		  case when f.at is null then '[]'::jsonb else
		   (select coalesce(jsonb_agg(i.item order by i.position),'[]'::jsonb)
		    from agent_session_item i where i.session_id=$1 and i.position >= f.at) end as tail,
		  case when f.at is null then '[]'::jsonb else
		   (select coalesce(jsonb_agg(jsonb_build_object('id', a.item_id, 'kind', a.kind,
		      'text', case when a.kind<>'agentMessage' then null
		        when length(a.item->>'text') <= 560 then a.item->>'text'
		        else left(a.item->>'text', 400) || chr(1) || right(a.item->>'text', 160) end) order by a.position desc),'[]'::jsonb)
		    from (select * from agent_session_item i where i.session_id=$1 and i.position < f.at
		     order by i.position desc limit ${ANCHOR_ROWS}) a) end as before
		 from s, c, f`,
		[sessionId, userId, since.rev, since.count],
	);
	const row = result.rows[0];
	if (!row) return null;
	return {
		token: { rev: Number(row.items_rev), count: row.item_count },
		projectId: row.project_id,
		harness: row.harness,
		turnStatus: row.turn_status,
		workspaceId: row.provider_ref ?? null,
		selectedBranch: row.selected_branch ?? null,
		listedModelId: row.listed_model_id ?? null,
		fromPosition: row.from_position ?? null,
		tail: row.tail,
		before: row.before,
	};
}
