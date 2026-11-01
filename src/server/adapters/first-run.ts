import { database } from "./database";

/** Records that the account left the first run; repeating it is harmless. */
export async function markFirstRunFinished(userId: string) {
	await database().query(
		"insert into user_first_run(user_id) values($1) on conflict (user_id) do nothing",
		[userId],
	);
}

export async function firstRunFinished(userId: string) {
	const result = await database().query(
		"select 1 from user_first_run where user_id=$1",
		[userId],
	);
	return result.rows.length > 0;
}
