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

/** A tool call's text above this many characters is cut for a page read (head and tail kept). */
export const PAGE_TEXT_CAP = 2048;

/** `text` with its middle replaced by a note once it passes PAGE_TEXT_CAP: head and tail stay (a command's exit line is at the tail). */
function capped(text: string) {
	const half = PAGE_TEXT_CAP / 2;
	return `(left(${text},${half}) || E'\\n… [' || (length(${text})-${PAGE_TEXT_CAP}) || ' characters omitted; open the card for all of it] …\\n' || right(${text},${half}))`;
}

/** Tools whose output and input are structured records the cards parse whole. */
const WHOLE_TOOLS = "('run_code','agent','agent_send')";
/** Input fields the collapsed card reads whole (command text, +/- line counts of a write or edit). */
const WHOLE_INPUT_KEYS =
	"('content','new_string','old_string','newText','oldText','command','cmd','code','diff','patch')";

/**
 * The item of row `row` (agent_session_item) as a page carries it, cut in the
 * database so the bytes never leave it; the whole item is one read away
 * (sessionItemForOwner, by id). A canvas's `html` is dropped (`htmlOmitted`);
 * a tool call's output (plain text, or the `output` text of a JSON record) and
 * its other long input texts keep their head and tail (PAGE_TEXT_CAP), with
 * `truncated: true`; both carry `detailSession`, the chat to read the whole item from. Messages and every other kind stay whole.
 */
export function pageItemSql(row = "i") {
	const out = `(select case
	  when s.x is null or length(s.x) <= ${PAGE_TEXT_CAP} then null
	  when pg_input_is_valid(s.x,'jsonb') then
	   case when jsonb_typeof(s.x::jsonb)='object' and jsonb_typeof(s.x::jsonb->'output')='string'
	     and length(s.x::jsonb->>'output') > ${PAGE_TEXT_CAP}
	    then jsonb_set(s.x::jsonb,'{output}',to_jsonb(${capped("(s.x::jsonb->>'output')")}))::text end
	  else ${capped("s.x")} end
	 from (select ${row}.item->>'output' as x) s)`;
	const input = `(select case
	  when s.x is null or length(s.x) <= ${PAGE_TEXT_CAP} or not pg_input_is_valid(s.x,'jsonb') or jsonb_typeof(s.x::jsonb)<>'object' then null
	  else (select case when bool_or(z.cut) then jsonb_object_agg(z.k,z.v)::text end
	   from (select e.key k,
	     case when cutting then to_jsonb(${capped("(e.value#>>'{}')")}) else e.value end v, cutting cut
	    from jsonb_each(s.x::jsonb) e
	    cross join lateral (select jsonb_typeof(e.value)='string' and e.key not in ${WHOLE_INPUT_KEYS}
	     and length(e.value#>>'{}') > ${PAGE_TEXT_CAP} as cutting) c) z) end
	 from (select ${row}.item->>'input' as x) s)`;
	return `(case
	 when ${row}.kind='canvas' and jsonb_typeof(${row}.item->'html')='string'
	  then jsonb_set(${row}.item,'{html}','null'::jsonb)
	   || jsonb_build_object('htmlOmitted',true,'detailSession',${row}.session_id)
	 when ${row}.kind='dynamicToolCall' and ${row}.item->>'tool' not in ${WHOLE_TOOLS}
	  and octet_length(${row}.item::text) > ${PAGE_TEXT_CAP}
	  then (select ${row}.item
	    || case when t.o is not null then jsonb_build_object('output',t.o) else '{}'::jsonb end
	    || case when t.n is not null then jsonb_build_object('input',t.n) else '{}'::jsonb end
	    || case when t.o is not null or t.n is not null then jsonb_build_object('truncated',true,'detailSession',${row}.session_id) else '{}'::jsonb end
	   from (select ${out} as o, ${input} as n) t)
	 else ${row}.item end)`;
}

/** With latestPageJoin: bounded latest items, and whether older items remain pageable. */
export const LATEST_PAGE_ITEMS_SQL = `(select coalesce(jsonb_agg(${pageItemSql("i")} order by i.position),'[]'::jsonb)
	 from agent_session_item i where i.session_id=s.id and i.position >= page.first)`;
export const LATEST_PAGE_HAS_OLDER_SQL = "page.first > 0";

/**
 * With latestPageJoin: the latest page's rows written after items revision
 * `since` (agent_session_item.rev), with their positions. A delta's rows.
 */
export function latestPageRowsSinceSql(since: string) {
	return `(select coalesce(jsonb_agg(jsonb_build_object('position',i.position,'item',${pageItemSql("i")}) order by i.position),'[]'::jsonb)
	 from agent_session_item i where i.session_id=s.id and i.position >= page.first and i.rev > ${since})`;
}
/** The chat's item count: one past its last stored position (primary-key index only). */
export const ITEM_COUNT_SQL = `(select coalesce(max(i.position)+1,0)::int from agent_session_item i where i.session_id=s.id)`;

/** Usage belongs to the session, even when its user-message row is on an older page. */
export const LATEST_CONTEXT_USAGE_SQL = `(select i.item->'contextUsage' from agent_session_item i
 where i.session_id=s.id and i.kind='userMessage' and i.item->'contextUsage' is not null
 order by i.position desc limit 1)`;
