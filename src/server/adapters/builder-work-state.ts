import {
	builderWorkState,
	builderWorkUpdate,
} from "#/domain/builder-work-state";
import { database } from "./database";

const key = "builder-work-state";

export async function readBuilderWorkState(userId: string, sessionId: string) {
	const result = await database().query(
		`select r.response from agent_task_command_receipt r join agent_session s on s.id=r.parent_session_id where s.user_id=$1 and s.id=$2 and r.request_id=$3`,
		[userId, sessionId, key],
	);
	return result.rows[0]
		? builderWorkState.parse(result.rows[0].response.result)
		: null;
}

/** One revision-fenced continuation record per session; existing journal storage and owner lock are reused. */
export async function saveBuilderWorkState(
	userId: string,
	sessionId: string,
	raw: unknown,
) {
	const update = builderWorkUpdate.parse(raw);
	const client = await database().connect();
	try {
		await client.query("begin");
		const owner = await client.query(
			"select id from agent_session where user_id=$1 and id=$2 for update",
			[userId, sessionId],
		);
		if (!owner.rowCount) throw new Error("This task is unavailable.");
		const previous = await client.query(
			"select response from agent_task_command_receipt where parent_session_id=$1 and request_id=$2",
			[sessionId, key],
		);
		const revision = previous.rows[0]
			? builderWorkState.parse(previous.rows[0].response.result).revision
			: 0;
		if (revision !== update.expectedRevision)
			throw new Error(
				"Work plan changed. Read the current plan before updating it.",
			);
		const { expectedRevision, ...content } = update;
		const result = builderWorkState.parse({
			...content,
			revision: expectedRevision + 1,
		});
		await client.query(
			`insert into agent_task_command_receipt(parent_session_id,request_id,status,response,completed_at) values($1,$2,'done',$3::jsonb,now()) on conflict(parent_session_id,request_id) do update set response=excluded.response,updated_at=now(),completed_at=now()`,
			[sessionId, key, JSON.stringify({ id: key, ok: true, result })],
		);
		await client.query("commit");
		return result;
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
}
