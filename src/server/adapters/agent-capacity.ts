import type { AgentSessionRecord } from "./agent-sessions";
import { database } from "./database";

export class ChildAdmissionDenied extends Error {}

export function modelConcurrencyLimits() {
	const worker = Number(process.env.YTIMESY_MODEL_CONCURRENCY ?? "4");
	const perUser = Number(process.env.YTIMESY_USER_TURN_CONCURRENCY ?? "8");
	const fleet = Number(process.env.YTIMESY_FLEET_TURN_CONCURRENCY ?? worker);
	const perTask = Number(process.env.YTIMESY_TASK_CHILD_CONCURRENCY ?? "3");
	if (!Number.isInteger(worker) || worker < 2 || worker > 32)
		throw new Error(
			"Model concurrency must be between 2 and 32 to reserve leader capacity.",
		);
	if (!Number.isInteger(perUser) || perUser < 2 || perUser > 64)
		throw new Error(
			"Per-user concurrency must be between 2 and 64 to reserve leader capacity.",
		);
	if (!Number.isInteger(fleet) || fleet < 2 || fleet > 10_000)
		throw new Error("Fleet concurrency must be between 2 and 10000.");
	if (!Number.isInteger(perTask) || perTask < 1 || perTask > 32)
		throw new Error("Per-task child concurrency must be between 1 and 32.");
	return {
		worker,
		fleet,
		perUser,
		maxChildren: Math.min(perTask, fleet - 1, perUser - 1),
	};
}

const OCCUPIED = `with occupied as (
	select s.id,s.user_id,s.parent_session_id from agent_session s
	where s.task_state='working' or s.turn_status='running'
	or exists(select 1 from api_turn t where t.session_id=s.id and t.state in ('queued','running'))
), counts as (
	select count(*)::int as total,
	count(*) filter(where user_id=$1)::int as owned,
	count(*) filter(where parent_session_id is null)::int as leaders,
	count(*) filter(where user_id=$1 and parent_session_id is null)::int as owned_leaders
	from occupied
)`;

export async function agentCapacity(userId: string) {
	const limits = modelConcurrencyLimits();
	const result = await database().query<{ available: number }>(
		`${OCCUPIED} select greatest(0,least($2-total-case when leaders=0 then 1 else 0 end,
		$3-owned-case when owned_leaders=0 then 1 else 0 end))::int as available from counts`,
		[userId, limits.fleet, limits.perUser],
	);
	return { ...limits, available: result.rows[0]?.available ?? 0 };
}

/** Planning sees the parent's occupied slots too; dispatch still owns atomic admission. */
export async function availableChildSlots(
	userId: string,
	parentSessionId: string,
) {
	const capacity = await agentCapacity(userId);
	const occupied = await database().query<{ active: number }>(
		`${OCCUPIED} select count(*)::int as active from occupied where user_id=$1 and parent_session_id=$2`,
		[userId, parentSessionId],
	);
	return Math.max(
		0,
		Math.min(
			capacity.available,
			capacity.maxChildren - (occupied.rows[0]?.active ?? capacity.maxChildren),
		),
	);
}

/** Reserve before provisioning. Concurrent starts share the dispatcher's short admission lock. */
export async function reserveAgentTaskStart(
	userId: string,
	projectId: string,
	taskId: string,
	expectedDraft?: AgentSessionRecord,
) {
	const limits = modelConcurrencyLimits();
	const client = await database().connect();
	try {
		await client.query("begin");
		await client.query("select pg_advisory_xact_lock(81738419)");
		const result = await client.query(
			`${OCCUPIED} update agent_session set task_state='working',turn_status='running',updated_at=now()
			where id=$4 and user_id=$1 and project_id=$5 and parent_session_id is not null
			and task_state in ('draft','idle') and turn_status <> 'running'
			${expectedDraft ? "and jsonb_build_array(parent_session_id,task_prompt,listed_model_id,harness,task_placement,task_access,task_execution,depends_on_session_id,selected_branch,base_branch)=$7::jsonb" : ""}
			and not exists(select 1 from api_turn t where t.session_id=$4 and t.state in ('queued','running'))
			and (select count(*) from occupied o where o.parent_session_id=agent_session.parent_session_id) < $6
			and (select total+case when leaders=0 then 1 else 0 end < $2
			and owned+case when owned_leaders=0 then 1 else 0 end < $3 from counts)
			returning id`,
			[
				userId,
				limits.fleet,
				limits.perUser,
				taskId,
				projectId,
				limits.maxChildren,
				...(expectedDraft
					? [
							JSON.stringify([
								expectedDraft.parentSessionId,
								expectedDraft.taskPrompt,
								expectedDraft.listedModelId,
								expectedDraft.harness,
								expectedDraft.taskPlacement,
								expectedDraft.taskAccess,
								expectedDraft.taskExecution,
								expectedDraft.dependsOnSessionId,
								expectedDraft.selectedBranch ?? null,
								expectedDraft.baseBranch ?? null,
							]),
						]
					: []),
			],
		);
		if (!result.rowCount)
			throw new ChildAdmissionDenied(
				`Child launch not admitted: capacity is full or the draft changed. At most ${limits.maxChildren} active children fit alongside a leader. Leave this task unstarted; steer existing children instead of creating replacements.`,
			);
		await client.query("commit");
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
}
