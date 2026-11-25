import { database } from "../database";

export type CheckpointStage =
	| "wake"
	| "export"
	| "upload"
	| "save"
	| "advanced";

/** Backstop for a crash between saving a settled turn and enqueueing its backup. */
export async function sessionsAwaitingCheckpoint() {
	const { rows } = await database().query<{ user_id: string; id: string }>(
		`select s.user_id,s.id from agent_session s
         left join session_checkpoint c on c.session_id=s.id
         where s.provider_ref is not null and s.turn_status in ('completed','failed')
           and (c.session_id is null or s.updated_at>c.created_at)
           and not exists (select 1 from session_checkpoint_failure f where f.session_id=s.id and f.retry_after>now())
           and (s.machine_released_at is null or s.updated_at>s.machine_released_at)
         order by s.updated_at desc limit 100`,
	);
	return rows;
}

/** How long a capture's in-flight lease lasts: longer than its 5-minute run limit. */
export const CHECKPOINT_RUN_LEASE_SECONDS = 6 * 60;

export type CheckpointRunClaim =
	| { kind: "claimed"; leaseId: string }
	/** Another run holds the session, or the fleet is at its capture limit. */
	| { kind: "busy" }
	/** The lease table is not there yet (code deployed before its migration). */
	| { kind: "unavailable" };

/**
 * Takes the session's in-flight lease, atomically: one run per session, and at
 * most `maxActive` runs at once across all sessions (a race between two ticks
 * can overshoot by one). An expired lease (a crashed or deployed-over run) is
 * taken over; the session's failure backoff still applies in
 * sessionsAwaitingCheckpoint.
 */
export async function claimSessionCheckpointRun(
	sessionId: string,
	maxActive: number,
	leaseId: string,
): Promise<CheckpointRunClaim> {
	try {
		const { rows } = await database().query<{ lease_id: string }>(
			`insert into session_checkpoint_run(session_id,lease_id,expires_at)
			 select $1::uuid,$2::uuid,now()+($4::int * interval '1 second')
			 where (select count(*) from session_checkpoint_run where expires_at>now() and session_id<>$1::uuid)<$3::int
			 on conflict(session_id) do update set lease_id=excluded.lease_id,started_at=now(),expires_at=excluded.expires_at
			   where session_checkpoint_run.expires_at<=now()
			 returning lease_id`,
			[sessionId, leaseId, maxActive, CHECKPOINT_RUN_LEASE_SECONDS],
		);
		return rows[0] ? { kind: "claimed", leaseId } : { kind: "busy" };
	} catch (error) {
		// Undefined table: the migration has not run; the caller falls back.
		if ((error as { code?: string } | null)?.code === "42P01")
			return { kind: "unavailable" };
		throw error;
	}
}

/** Lets the session be captured again; only the run that holds the lease can. */
export async function releaseSessionCheckpointRun(
	sessionId: string,
	leaseId: string,
) {
	await database().query(
		"delete from session_checkpoint_run where session_id=$1 and lease_id=$2",
		[sessionId, leaseId],
	);
}

/** Backs off 5 minutes, doubling to a day, so a failing capture cannot keep its VM awake. */
export async function recordCheckpointFailure(
	sessionId: string,
	stage: CheckpointStage,
	/** A failure that repeats until the workspace changes: wait a day. */
	lasting = false,
) {
	await database().query(
		`insert into session_checkpoint_failure(session_id,failures,stage,retry_after)
         select id,1,$2,now()+interval '5 minutes' from agent_session where id=$1
         on conflict(session_id) do update set failures=session_checkpoint_failure.failures+1,stage=excluded.stage,failed_at=now(),
           retry_after=now()+least(interval '5 minutes'*power(2,least(session_checkpoint_failure.failures,9)),interval '1 day')`,
		[sessionId, stage],
	);
	if (lasting)
		await database().query(
			"update session_checkpoint_failure set retry_after=now()+interval '1 day' where session_id=$1",
			[sessionId],
		);
}

export async function clearCheckpointFailure(sessionId: string) {
	await database().query(
		"delete from session_checkpoint_failure where session_id=$1",
		[sessionId],
	);
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
