import { hubTopic } from "#/domain/user-hub";
import { database } from "./database";
import { noteUserHub } from "./user-hub-notes";

export function modelConcurrencyLimits() {
	const worker = Number(process.env.YTIMESY_MODEL_CONCURRENCY ?? "4");
	const perUser = Number(process.env.YTIMESY_USER_TURN_CONCURRENCY ?? "32");
	// Each edge chat runs in its own Durable Object, so the fleet is not one worker's slots.
	const fleet = Number(process.env.YTIMESY_FLEET_TURN_CONCURRENCY ?? "256");
	if (!Number.isInteger(worker) || worker < 2 || worker > 32)
		throw new Error("Model concurrency must be between 2 and 32.");
	if (!Number.isInteger(perUser) || perUser < 2 || perUser > 64)
		throw new Error("Per-user concurrency must be between 2 and 64.");
	if (!Number.isInteger(fleet) || fleet < 2 || fleet > 10_000)
		throw new Error("Fleet concurrency must be between 2 and 10000.");
	return { worker, fleet, perUser };
}

/**
 * Marks an opened subagent working before its first send, so a second start
 * of the same row fails. How many subagents run is admitted earlier, by
 * subagentAdmission (depth, live children, tree size, budget); turns still
 * queue behind the per-user and fleet limits at dispatch.
 */
export async function reserveAgentTaskStart(
	userId: string,
	projectId: string,
	taskId: string,
) {
	const result = await database().query(
		`update agent_session set task_state='working',turn_status='running',updated_at=now()
		where id=$3 and user_id=$1 and project_id=$2 and parent_session_id is not null
		and task_state in ('draft','idle') and turn_status <> 'running'
		and not exists(select 1 from api_turn t where t.session_id=$3 and t.state in ('queued','running'))
		returning id,parent_session_id`,
		[userId, projectId, taskId],
	);
	if (!result.rowCount)
		throw new Error("The subagent is already running or no longer available.");
	const parent = (result.rows[0] as { parent_session_id?: string } | undefined)
		?.parent_session_id;
	if (parent) noteUserHub(userId, [hubTopic.agents(parent)]);
}
