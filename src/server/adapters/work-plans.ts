import { randomUUID } from "node:crypto";
import {
	type DurableWorkPlan,
	durableWorkPlan,
} from "#/domain/durable-work-plan";
import { database } from "./database";

function response(plan: DurableWorkPlan) {
	return JSON.stringify({
		id: `work-plan:${plan.id}`,
		ok: true,
		result: durableWorkPlan.parse(plan),
	});
}

/** One coordination plan per lead; the existing owner-scoped journal supplies durability. */
export async function insertWorkPlan(
	userId: string,
	parentId: string,
	plan: DurableWorkPlan,
) {
	const client = await database().connect();
	try {
		await client.query("begin");
		const owner = await client.query(
			"select id from agent_session where id=$1 and user_id=$2 and parent_session_id is null for update",
			[parentId, userId],
		);
		if (!owner.rowCount) throw new Error("The lead is not available.");
		const duplicate = await client.query(
			"select response from agent_task_command_receipt where parent_session_id=$1 and request_id=$2",
			[parentId, `work-plan:${plan.id}`],
		);
		if (duplicate.rows[0]) {
			const existing = durableWorkPlan.parse(duplicate.rows[0].response.result);
			await client.query("commit");
			return existing;
		}
		const active = await client.query(
			`select request_id from agent_task_command_receipt where parent_session_id=$1 and request_id like 'work-plan:%' and response->'result'->>'status' not in ('completed','cancelled')`,
			[parentId],
		);
		if (active.rowCount)
			throw new Error(
				"Cancel the existing plan before replacing it; already started tasks are not stopped by cancellation.",
			);
		await client.query(
			"insert into agent_task_command_receipt(parent_session_id,request_id,status,response,completed_at) values($1,$2,'done',$3::jsonb,now())",
			[parentId, `work-plan:${plan.id}`, response(plan)],
		);
		await client.query("commit");
		return plan;
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
}

export async function readWorkPlan(
	userId: string,
	parentId: string,
	id: string,
) {
	const found = await database().query(
		`select r.response from agent_task_command_receipt r join agent_session s on s.id=r.parent_session_id where s.id=$1 and s.user_id=$2 and r.request_id=$3`,
		[parentId, userId, `work-plan:${id}`],
	);
	if (!found.rows[0]) throw new Error("The plan is not available.");
	return durableWorkPlan.parse(found.rows[0].response.result);
}

export async function setWorkPlanStatus(
	userId: string,
	parentId: string,
	id: string,
	action: "pause" | "resume" | "cancel",
) {
	const updated = await database().query(
		`update agent_task_command_receipt r set response=jsonb_set(jsonb_set(r.response,'{result,status}',to_jsonb($4::text)),'{result,lease}','null'::jsonb),updated_at=now() from agent_session s where r.parent_session_id=s.id and s.id=$1 and s.user_id=$2 and r.request_id=$3 and r.response->'result'->>'status' not in ('completed','cancelled') and ($4='cancelled' or r.response->'result'->>'status' in ('active','paused')) and ($4 <> 'active' or r.response->'result'->>'status'='paused') returning r.response`,
		[
			parentId,
			userId,
			`work-plan:${id}`,
			action === "pause"
				? "paused"
				: action === "resume"
					? "active"
					: "cancelled",
		],
	);
	if (!updated.rows[0])
		throw new Error(
			"The plan cannot make that transition. Blocked or uncertain work must be inspected, not resumed automatically.",
		);
	return durableWorkPlan.parse(updated.rows[0].response.result);
}

/** Leases exclude duplicate workers; expired dispatching nodes are observed, never replayed. */
export async function claimWorkPlan() {
	const token = randomUUID();
	const claimed = await database().query(
		`with candidate as (
	 select r.parent_session_id,r.request_id from agent_task_command_receipt r
	 where r.request_id like 'work-plan:%' and r.response->'result'->>'type'='work-plan' and r.response->'result'->>'status'='active'
	 and (r.response->'result'->'lease' is null or r.response->'result'->'lease'='null'::jsonb or (r.response->'result'->'lease'->>'until')::numeric < extract(epoch from now())*1000)
	 order by r.updated_at asc for update skip locked limit 1
	) update agent_task_command_receipt r set response=jsonb_set(r.response,'{result,lease}',jsonb_build_object('token',$1::text,'until',extract(epoch from now()+interval '5 minutes')*1000)),updated_at=now()
	 from candidate c where r.parent_session_id=c.parent_session_id and r.request_id=c.request_id returning r.parent_session_id,r.response`,
		[token],
	);
	if (!claimed.rows[0]) return null;
	return {
		parentId: claimed.rows[0].parent_session_id as string,
		plan: durableWorkPlan.parse(claimed.rows[0].response.result),
		token,
	};
}

export async function saveClaimedWorkPlan(
	parentId: string,
	token: string,
	plan: DurableWorkPlan,
	release = false,
) {
	const saved = await database().query(
		`update agent_task_command_receipt set response=$4::jsonb,updated_at=now() where parent_session_id=$1 and request_id=$2 and response->'result'->'lease'->>'token'=$3 and response->'result'->>'status'='active' returning request_id`,
		[
			parentId,
			`work-plan:${plan.id}`,
			token,
			response({
				...plan,
				lease: release ? null : { token, until: Date.now() + 300_000 },
			}),
		],
	);
	if (!saved.rowCount)
		throw new Error(
			"Plan claim was lost or paused. Dispatch outcome must be inspected before retrying.",
		);
}

export async function renewWorkPlanClaim(
	parentId: string,
	id: string,
	token: string,
) {
	const renewed = await database().query(
		`update agent_task_command_receipt set response=jsonb_set(response,'{result,lease,until}',to_jsonb((extract(epoch from now()+interval '5 minutes')*1000)::numeric)),updated_at=now() where parent_session_id=$1 and request_id=$2 and response->'result'->'lease'->>'token'=$3 and response->'result'->>'status'='active' returning request_id`,
		[parentId, `work-plan:${id}`, token],
	);
	if (!renewed.rowCount) throw new Error("Plan claim was lost or paused.");
}

export async function taskHasDurableLaunch(taskId: string) {
	const result = await database().query(
		"select id from api_turn where session_id=$1 limit 1",
		[taskId],
	);
	return Boolean(result.rowCount);
}

/** Notify the lead without rewriting a partially started child's runtime state. */
export async function notifyBlockedWorkPlan(
	userId: string,
	parentId: string,
	plan: DurableWorkPlan,
) {
	const node =
		plan.nodes.find(
			(node) => node.state === "uncertain" || node.state === "failed",
		) ?? plan.nodes[0];
	const inserted = await database().query(
		`insert into agent_task_event(id,user_id,parent_session_id,child_session_id,event_type,dedupe_key,payload)
	 select $4::uuid,s.user_id,s.parent_session_id,s.id,'blocked',$5,$6::jsonb from agent_session s join agent_session p on p.id=s.parent_session_id
	 where s.id=$1 and s.parent_session_id=$2 and s.user_id=$3 and p.user_id=$3
	 on conflict(dedupe_key) do nothing returning id`,
		[
			node.taskId,
			parentId,
			userId,
			randomUUID(),
			`work-plan:${plan.id}:blocked`,
			JSON.stringify({
				message: `Dependency plan ${plan.id} is blocked. Read read_task_plan and inspect preserved child work before cancelling or replacing it. No uncertain launch was replayed.`,
			}),
		],
	);
	return inserted.rows[0]?.id as string | undefined;
}
