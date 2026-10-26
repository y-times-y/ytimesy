/**
 * SQL that slices a chat's stored transcript (agent_session.items, a jsonb
 * array) into pages of whole turns, as transcriptPageBefore in
 * domain/transcript-page.ts does, so only the page leaves the database.
 */

/** Whether the stored item `e.it` starts a turn (startsTurn in child-task-activity.ts). */
export const STARTS_TURN_SQL = `(e.it->>'kind'='userMessage' or (e.it->>'kind'='notice' and e.it->>'wake'='true'))`;

/**
 * Joins `page.first`: the 1-based position where the last `turns` turns of
 * the row `s` begin (1 when it holds no more). One pass over the array.
 */
export function latestPageJoin(turns: number) {
	if (!Number.isInteger(turns) || turns < 1) throw new Error("Invalid page.");
	return `cross join lateral (select case when count(*) < ${turns} then 1 else min(t.o) end as first
	 from (select e.o from jsonb_array_elements(s.items) with ordinality e(it,o)
	  where ${STARTS_TURN_SQL} order by e.o desc limit ${turns}) t) page`;
}

/** With latestPageJoin: the row's last turns, and whether it holds turns before them. */
export const LATEST_PAGE_ITEMS_SQL = `jsonb_path_query_array(s.items, ('$[' || (page.first-1) || ' to last]')::jsonpath)`;
export const LATEST_PAGE_HAS_OLDER_SQL = "page.first > 1";
