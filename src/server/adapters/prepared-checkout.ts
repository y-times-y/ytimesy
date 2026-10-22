import { jsonbText } from "#/domain/jsonb";
import { database } from "./database";

/**
 * Facts a turn learns preparing its workspace, kept in the session's receipt
 * journal (agent_task_command_receipt, no schema change) so a later turn can
 * build its first model request before its VM is ready.
 */
const DIRECTORY_KEY = "prepared-checkout-directory";

/**
 * The repository path this chat's workspace last reported; for a chat that
 * has none yet, the latest one another root chat of the same project
 * reported (chats copy the same project template). Null when neither exists.
 */
export async function readPreparedCheckoutDirectory(
	userId: string,
	sessionId: string,
	projectId: string | null,
): Promise<string | null> {
	const result = await database().query<{ directory: unknown }>(
		`select r.response->'result'->>'directory' as directory
		 from agent_task_command_receipt r join agent_session s on s.id=r.parent_session_id
		 where s.user_id=$2 and r.request_id=$4 and r.status='done'
		 and (s.id=$1 or ($3::uuid is not null and s.project_id=$3::uuid and s.parent_session_id is null))
		 order by (s.id=$1) desc, r.updated_at desc limit 1`,
		[sessionId, userId, projectId, DIRECTORY_KEY],
	);
	const directory = result.rows[0]?.directory;
	return typeof directory === "string" && directory.startsWith("/")
		? directory
		: null;
}

/** Records the path a prepared workspace reported; a no-op when unchanged. */
export async function savePreparedCheckoutDirectory(
	userId: string,
	sessionId: string,
	directory: string,
) {
	if (!directory.startsWith("/")) return;
	await database().query(
		`insert into agent_task_command_receipt(parent_session_id,request_id,status,response,completed_at)
		 select id,$3,'done',$4::jsonb,now() from agent_session where id=$1 and user_id=$2
		 on conflict(parent_session_id,request_id) do update set response=excluded.response,status='done',completed_at=now(),updated_at=now()
		 where agent_task_command_receipt.response is distinct from excluded.response`,
		[
			sessionId,
			userId,
			DIRECTORY_KEY,
			jsonbText({ id: DIRECTORY_KEY, ok: true, result: { directory } }),
		],
	);
}

/**
 * A value derived from content-addressed input (a lifecycle configuration
 * read from a baseline commit): written once, never changed.
 */
export async function readSessionDerivedValue(
	userId: string,
	sessionId: string,
	key: string,
): Promise<unknown> {
	const result = await database().query<{ value: unknown }>(
		`select r.response->'result' as value from agent_task_command_receipt r join agent_session s on s.id=r.parent_session_id
		 where s.id=$1 and s.user_id=$2 and r.request_id=$3 and r.status='done' and r.response->>'ok'='true'`,
		[sessionId, userId, key],
	);
	return result.rows[0]?.value ?? null;
}

export async function saveSessionDerivedValue(
	userId: string,
	sessionId: string,
	key: string,
	value: unknown,
) {
	await database().query(
		`insert into agent_task_command_receipt(parent_session_id,request_id,status,response,completed_at)
		 select id,$3,'done',$4::jsonb,now() from agent_session where id=$1 and user_id=$2
		 on conflict(parent_session_id,request_id) do nothing`,
		[sessionId, userId, key, jsonbText({ id: key, ok: true, result: value })],
	);
}

/**
 * The same derived value as journaled by another root chat of this user's
 * project (the latest one): a value derived from content-addressed input is
 * the same for every chat that names the same input in its key.
 */
export async function readProjectDerivedValue(
	userId: string,
	projectId: string,
	key: string,
): Promise<unknown> {
	const result = await database().query<{ value: unknown }>(
		`select r.response->'result' as value from agent_task_command_receipt r join agent_session s on s.id=r.parent_session_id
		 where s.user_id=$1 and s.project_id=$2::uuid and s.parent_session_id is null
		 and r.request_id=$3 and r.status='done' and r.response->>'ok'='true'
		 order by r.updated_at desc limit 1`,
		[userId, projectId, key],
	);
	return result.rows[0]?.value ?? null;
}
