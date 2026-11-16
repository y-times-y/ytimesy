import {
	TRANSCRIPT_PAGE_BYTES,
	TRANSCRIPT_PAGE_ITEMS,
} from "#/domain/transcript-page";

/**
 * SQL that slices a chat's stored transcript into pages of whole turns, as
 * transcriptPageBefore in domain/transcript-page.ts does, so only the page
 * leaves the database. It reads agent_session_item (one row per item, kept
 * in step with agent_session.items by a trigger; see
 * supabase/migrations/20261026100000_agent_session_item.sql): a page reads
 * its own rows and the turn-start index, never the whole history. Its
 * `starts_turn` is startsTurn in child-task-activity.ts. Positions are 0-based.
 */

/**
 * Joins `page.first`: the position where the last `turns` turns of the row
 * `s` begin (0 when it holds no more).
 */
export function latestPageJoin(turns: number) {
	if (!Number.isInteger(turns) || turns < 1) throw new Error("Invalid page.");
	return `cross join lateral (select case when count(*) < ${turns} then 0 else min(t.position) end as first
	 from (select i.position from agent_session_item i where i.session_id=s.id and i.starts_turn
	  order by i.position desc limit ${turns}) t) turn_page
	 cross join lateral (select ${boundedPageStartSql("s.id", "turn_page.first")} as first) page`;
}

/** How much one page may hold at most (the newest item always fits). */
export type PageLimits = { readonly bytes: number; readonly items: number };

/** Indexed, bounded candidate rows; PostgreSQL keeps the rest of a long turn out of the Worker. */
export function boundedPageStartSql(
	session: string,
	first: string,
	stop?: string,
	limits: PageLimits = {
		bytes: TRANSCRIPT_PAGE_BYTES,
		items: TRANSCRIPT_PAGE_ITEMS,
	},
) {
	if (
		!Number.isInteger(limits.bytes) ||
		!Number.isInteger(limits.items) ||
		limits.bytes < 1 ||
		limits.items < 1
	)
		throw new Error("Invalid page.");
	return `(select coalesce(min(p.position) filter (where p.used_bytes <= ${limits.bytes} or p.ordinal=1),0)
	 from (select candidates.position,
	 sum(candidates.bytes) over (order by candidates.position desc) as used_bytes,
	 row_number() over (order by candidates.position desc) as ordinal
	 from (select i.position,octet_length(i.item::text) as bytes from agent_session_item i
	 where i.session_id=${session} and i.position >= ${first}${stop ? ` and i.position < ${stop}` : ""}
	 order by i.position desc limit ${limits.items}) candidates) p)`;
}

/** With latestPageJoin: bounded latest items, and whether older items remain pageable. */
export const LATEST_PAGE_ITEMS_SQL = `(select coalesce(jsonb_agg(i.item order by i.position),'[]'::jsonb)
	 from agent_session_item i where i.session_id=s.id and i.position >= page.first)`;
export const LATEST_PAGE_HAS_OLDER_SQL = "page.first > 0";

/**
 * With latestPageJoin: the latest page's rows written after items revision
 * `since` (agent_session_item.rev), with their positions. A delta's rows.
 */
export function latestPageRowsSinceSql(since: string) {
	return `(select coalesce(jsonb_agg(jsonb_build_object('position',i.position,'item',i.item) order by i.position),'[]'::jsonb)
	 from agent_session_item i where i.session_id=s.id and i.position >= page.first and i.rev > ${since})`;
}
/** The chat's item count: one past its last stored position (primary-key index only). */
export const ITEM_COUNT_SQL = `(select coalesce(max(i.position)+1,0)::int from agent_session_item i where i.session_id=s.id)`;

/** Usage belongs to the session, even when its user-message row is on an older page. */
export const LATEST_CONTEXT_USAGE_SQL = `(select i.item->'contextUsage' from agent_session_item i
 where i.session_id=s.id and i.kind='userMessage' and i.item->'contextUsage' is not null
 order by i.position desc limit 1)`;
