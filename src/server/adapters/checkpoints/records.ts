import { database } from "../database";

/** Backstop for a crash between saving a settled turn and enqueueing its backup. */
export async function sessionsAwaitingCheckpoint() {
	const { rows } = await database().query<{ user_id: string; id: string }>(
		`select s.user_id,s.id from agent_session s
         left join session_checkpoint c on c.session_id=s.id
         where s.provider_ref is not null and s.turn_status in ('completed','failed')
           and (c.session_id is null or s.updated_at>c.created_at)
         order by s.updated_at desc limit 100`,
	);
	return rows;
}

export async function checkpointForSession(userId: string, sessionId: string) {
	const { rows } = await database().query<{
		object_path: string;
		executor_id: string;
		runner_id: string | null;
		turn_fingerprint: string;
		workspace_sha256: string | null;
	}>(
		"select object_path,executor_id,runner_id,turn_fingerprint,workspace_sha256 from session_checkpoint where user_id=$1 and session_id=$2",
		[userId, sessionId],
	);
	return rows[0] ?? null;
}

export async function confirmUnchangedCheckpoint(
	userId: string,
	sessionId: string,
	fingerprint: string,
) {
	await database().query(
		"update session_checkpoint set created_at=now() where user_id=$1 and session_id=$2 and turn_fingerprint=$3",
		[userId, sessionId, fingerprint],
	);
}

export async function saveSessionCheckpoint(input: {
	userId: string;
	sessionId: string;
	path: string;
	fingerprint: string;
	executorId: string;
	runnerId: string | null;
	workspaceSha256: string;
}) {
	const result = await database().query(
		`insert into session_checkpoint(session_id,user_id,object_path,turn_fingerprint,executor_id,runner_id,workspace_sha256) select id,user_id,$3,$4,$5,$6,$7 from agent_session where user_id=$1 and id=$2 on conflict(session_id) do update set object_path=excluded.object_path,turn_fingerprint=excluded.turn_fingerprint,executor_id=excluded.executor_id,runner_id=excluded.runner_id,workspace_sha256=excluded.workspace_sha256,created_at=now()`,
		[
			input.userId,
			input.sessionId,
			input.path,
			input.fingerprint,
			input.executorId,
			input.runnerId,
			input.workspaceSha256,
		],
	);
	if (result.rowCount !== 1)
		throw new Error("Conversation was deleted before checkpoint commit.");
}
