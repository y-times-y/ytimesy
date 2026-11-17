import { database } from "./database";

/** A box is alive if it registered this recently (it registers every few seconds). */
export const TURN_RUNNER_BOX_FRESH_SECONDS = 45;

export async function registerTurnRunnerBox(input: {
	readonly id: string;
	readonly capacity: number;
	readonly running: number;
	readonly version?: string;
}): Promise<boolean> {
	// A revoked box keeps its row (and stays revoked) but is no longer registered.
	const result = await database().query(
		`insert into turn_runner_box(id,capacity,running,version,last_seen_at) values($1,$2,$3,$4,now())
		 on conflict(id) do update set capacity=excluded.capacity,running=excluded.running,version=excluded.version,last_seen_at=now()
		 where turn_runner_box.revoked_at is null returning id`,
		[input.id, input.capacity, input.running, input.version ?? null],
	);
	return result.rows.length > 0;
}

/** Stops the edge serving this box (claims, renewals, model requests) until it is deleted. */
export async function revokeTurnRunnerBox(id: string) {
	await database().query(
		`insert into turn_runner_box(id,capacity,running,revoked_at) values($1,1,0,now())
		 on conflict(id) do update set revoked_at=now()`,
		[id],
	);
}

/** False for a box whose identity was revoked; an unknown box is not revoked. */
export async function turnRunnerBoxActive(id: string): Promise<boolean> {
	const result = await database().query(
		"select 1 from turn_runner_box where id=$1 and revoked_at is not null",
		[id],
	);
	return result.rows.length === 0;
}

export async function removeTurnRunnerBox(id: string) {
	await database().query("delete from turn_runner_box where id=$1", [id]);
}

/** Whether a box with room for another turn was seen lately. */
export async function turnRunnerBoxAlive(): Promise<boolean> {
	const result = await database().query<{ alive: boolean }>(
		`select exists(select 1 from turn_runner_box
		 where last_seen_at > now() - make_interval(secs => $1) and running < capacity and revoked_at is null) as alive`,
		[TURN_RUNNER_BOX_FRESH_SECONDS],
	);
	return result.rows[0]?.alive === true;
}

/**
 * What routing needs to know about a chat before its turn is queued
 * (turn-executor.ts `boxTurnBlock`): one read, no write. A runtime secret
 * counts whether the project or the user's account holds it (a project's own
 * secret of the same name would shadow an account one; ignoring that only
 * keeps more turns off the box, never fewer).
 */
export async function boxRoutingFacts(userId: string, sessionId: string) {
	const result = await database().query<{
		subagent: boolean;
		runtime_secrets: boolean;
	}>(
		`select s.parent_session_id is not null as subagent,
		 (exists(select 1 from project_secret ps where ps.project_id=s.project_id and ps.kind='runtime')
		  or exists(select 1 from account_secret a where a.user_id=s.user_id and a.kind='runtime')) as runtime_secrets
		 from agent_session s where s.id=$1 and s.user_id=$2`,
		[sessionId, userId],
	);
	const row = result.rows[0];
	return {
		subagent: row?.subagent ?? false,
		hasRuntimeSecrets: row?.runtime_secrets ?? false,
	};
}
