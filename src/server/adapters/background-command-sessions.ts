import { jsonbText } from "#/domain/jsonb";
import type { SessionItem } from "#/domain/session-item";
import { database } from "./database";

/**
 * Chats between turns whose timeline records a background command that has
 * not exited (DynamicToolCallItem.background without exitCode), updated within
 * the background cap (a running command's chat was updated when it started).
 */
export async function idleSessionsWithOpenBackgroundCommands(
	maxSeconds: number,
	limit = 20,
) {
	const result = await database().query<{ user_id: string; id: string }>(
		`select s.user_id,s.id from agent_session s
		 where s.provider_ref is not null and s.turn_status <> 'running'
		   and s.updated_at > now() - make_interval(secs => $1)
		   and exists (select 1 from agent_session_item i where i.session_id=s.id
		     and i.kind = 'dynamicToolCall'
		     and i.item->'background' is not null
		     and (i.item #> '{background,exitCode}') is null)
		 order by s.updated_at limit $2`,
		[maxSeconds + 600, limit],
	);
	return result.rows.map((row) => ({ userId: row.user_id, id: row.id }));
}

/** Compare-and-set of an idle chat's timeline; a turn that started meanwhile owns it. */
export async function replaceIdleSessionItems(
	userId: string,
	sessionId: string,
	expected: unknown,
	next: readonly SessionItem[],
) {
	const result = await database().query(
		`update agent_session set items=$3::jsonb,updated_at=now()
		 where id=$1 and user_id=$2 and turn_status is distinct from 'running' and items=$4::jsonb`,
		[sessionId, userId, jsonbText(next), jsonbText(expected)],
	);
	return (result.rowCount ?? 0) > 0;
}
