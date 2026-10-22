import { jsonbText } from "#/domain/jsonb";
import { database } from "./database";
import { MACHINE_PREWARM_KEY } from "./prepared-checkout";

/**
 * A new chat's machine copied while its first message is typed, recorded in
 * the chat's receipt journal (no schema change): processing while the copy
 * runs, then the snapshot and VM it made. The chat adopts the VM by its slug
 * when its first turn binds a machine; one never adopted is deleted after
 * PREWARM_UNUSED_MINUTES (sweepUnusedChatMachines).
 */
export const PREWARM_UNUSED_MINUTES = 10;

/** Receipts of copies still waiting for their chat's first turn. */
const WAITING = `r.request_id='${MACHINE_PREWARM_KEY}' and s.provider_ref is null
 and coalesce(r.response->'result'->>'swept','')=''
 and not exists (select 1 from api_turn t where t.session_id=s.id)`;

/**
 * Claims the copy for an empty root chat without a machine: false when the
 * chat already has one claimed, or another of the user's chats still waits
 * on its copy (one at a time, so typing in several tabs does not fan out).
 * The user's claims serialize on a transaction lock.
 */
export async function claimMachinePrewarm(userId: string, sessionId: string) {
	const client = await database().connect();
	try {
		await client.query("begin");
		await client.query("select pg_advisory_xact_lock(hashtext($1))", [
			`ytimesy:machine-prewarm:${userId}`,
		]);
		const waiting = await client.query(
			`select 1 from agent_task_command_receipt r join agent_session s on s.id=r.parent_session_id
			 where s.user_id=$1 and r.created_at > now()-make_interval(mins => $2) and ${WAITING} limit 1`,
			[userId, PREWARM_UNUSED_MINUTES],
		);
		const claimed = waiting.rows.length
			? { rows: [] }
			: await client.query(
					`insert into agent_task_command_receipt(parent_session_id,request_id,status)
					 select id,$3,'processing' from agent_session
					 where id=$1 and user_id=$2 and provider_ref is null and parent_session_id is null
					 and turn_status <> 'running' and coalesce(jsonb_array_length(items),0)=0
					 on conflict(parent_session_id,request_id) do nothing returning 1`,
					[sessionId, userId, MACHINE_PREWARM_KEY],
				);
		await client.query("commit");
		return claimed.rows.length > 0;
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
}

/**
 * Records the copy's outcome: its snapshot and VM, that it failed, or that
 * it was deleted unused (the chat's first turn then makes its own).
 */
export async function finishMachinePrewarm(
	sessionId: string,
	result:
		| { snapshotId: string; vmId: string }
		| { failed: true }
		| { swept: true },
) {
	await database().query(
		`update agent_task_command_receipt set status='done',response=$3::jsonb,completed_at=now()
		 where parent_session_id=$1 and request_id=$2`,
		[
			sessionId,
			MACHINE_PREWARM_KEY,
			jsonbText({ id: MACHINE_PREWARM_KEY, ok: true, result }),
		],
	);
}

/**
 * Copies whose chat sent nothing within PREWARM_UNUSED_MINUTES: their VM by
 * the receipt, else by the machine's usage admission (a copy that never
 * reported back).
 */
export async function unusedMachinePrewarms(limit = 20) {
	const result = await database().query<{
		session_id: string;
		vm_id: string | null;
	}>(
		`select s.id session_id, coalesce(r.response->'result'->>'vmId', a.vm_id) vm_id
		 from agent_task_command_receipt r join agent_session s on s.id=r.parent_session_id
		 left join infrastructure_vm_admission a on a.slug='ytimesy-ag-'||left(replace(s.id::text,'-',''),16)
		 where r.created_at < now()-make_interval(mins => $1) and ${WAITING}
		 order by r.created_at limit $2`,
		[PREWARM_UNUSED_MINUTES, limit],
	);
	return result.rows;
}

/** The VM a chat's copy made, while the chat has not adopted it. */
export async function prewarmedMachine(userId: string, sessionId: string) {
	const result = await database().query<{ vm_id: string | null }>(
		`select coalesce(r.response->'result'->>'vmId', a.vm_id) vm_id
		 from agent_task_command_receipt r join agent_session s on s.id=r.parent_session_id
		 left join infrastructure_vm_admission a on a.slug='ytimesy-ag-'||left(replace(s.id::text,'-',''),16)
		 where s.id=$1 and s.user_id=$2 and ${WAITING}`,
		[sessionId, userId],
	);
	return result.rows[0]?.vm_id ?? null;
}
