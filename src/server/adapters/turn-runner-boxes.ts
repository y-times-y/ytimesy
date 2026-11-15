import { database } from "./database";

/** A box is alive if it registered this recently (it registers every few seconds). */
export const TURN_RUNNER_BOX_FRESH_SECONDS = 45;

export async function registerTurnRunnerBox(input: {
	readonly id: string;
	readonly capacity: number;
	readonly running: number;
	readonly version?: string;
}) {
	await database().query(
		`insert into turn_runner_box(id,capacity,running,version,last_seen_at) values($1,$2,$3,$4,now())
		 on conflict(id) do update set capacity=excluded.capacity,running=excluded.running,version=excluded.version,last_seen_at=now()`,
		[input.id, input.capacity, input.running, input.version ?? null],
	);
}

export async function removeTurnRunnerBox(id: string) {
	await database().query("delete from turn_runner_box where id=$1", [id]);
}

/** Whether a box with room for another turn was seen lately. */
export async function turnRunnerBoxAlive(): Promise<boolean> {
	const result = await database().query<{ alive: boolean }>(
		`select exists(select 1 from turn_runner_box
		 where last_seen_at > now() - make_interval(secs => $1) and running < capacity) as alive`,
		[TURN_RUNNER_BOX_FRESH_SECONDS],
	);
	return result.rows[0]?.alive === true;
}
