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
		`select user_id,id from agent_session
		 where provider_ref is not null and turn_status <> 'running'
		   and updated_at > now() - make_interval(secs => $1)
		   and jsonb_path_exists(items, '$[*] ? (@.kind == "dynamicToolCall" && exists(@.background) && !exists(@.background.exitCode))')
		 order by updated_at limit $2`,
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
