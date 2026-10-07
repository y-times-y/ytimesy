import { z } from "zod";
import type { AgentTaskToolResponse } from "#/domain/agent-task-tool";
import { sessionItemsFromUnknown } from "#/domain/session-item";
import { taskVerificationAssignment } from "#/domain/task-verification-assignment";
import { database } from "./database";

/** Successful batch integration is server work; only a visible failure permits model repair. */
export async function isServerControlledIntegration(task: {
	readonly id: string;
	readonly userId: string;
	readonly projectId: string;
	readonly parentSessionId: string | null;
	readonly taskState: string | null;
	readonly items?: unknown;
}) {
	if (!task.parentSessionId || task.taskState === "failed") return false;
	// A repair turn changes working/done state, but must not erase the server's failure witness.
	if (
		sessionItemsFromUnknown(task.items).some(
			(item) =>
				item.kind === "error" &&
				(item.id === `${task.id}:failure` ||
					item.id === `${task.id}:stage-failure`),
		)
	)
		return false;
	const batch = await readyBatchIntegration(
		task.userId,
		task.projectId,
		task.parentSessionId,
		task.id,
	);
	return batch?.taskId === task.id;
}

/** Only a server-created batch draft may be resumed by incremental integration. */
export async function readyBatchIntegration(
	userId: string,
	projectId: string,
	parentId: string,
	taskId: string,
) {
	const result = await database().query<{
		integration_id: string;
		source_ids: unknown;
	}>(
		`select r.response->'result'->'integration'->>'taskId' as integration_id,
		 (select jsonb_agg(t->'result'->>'taskId') from jsonb_array_elements(r.response->'result'->'tasks') t) as source_ids
		 from agent_task_command_receipt r
		 join agent_session p on p.id=r.parent_session_id
		 join agent_session d on d.id::text=r.response->'result'->'integration'->>'taskId'
		 where p.id=$1 and p.user_id=$2 and p.project_id=$3
		 and d.user_id=p.user_id and d.project_id=p.project_id and d.parent_session_id=p.id
		 and r.status='done' and r.response->>'ok'='true'
		 and r.response->'result'->>'kind'='ready-task-verification-v1'
		 and (d.id::text=$4 or exists(select 1 from jsonb_array_elements(r.response->'result'->'tasks') t where t->'result'->>'taskId'=$4))`,
		[parentId, userId, projectId, taskId],
	);
	if (!result.rows.length) return null;
	if (result.rows.length !== 1)
		throw new Error("Integration batch is ambiguous.");
	const row = result.rows[0];
	return {
		taskId: z.string().min(1).parse(row.integration_id),
		sourceTaskIds: z
			.array(z.string().min(1))
			.min(2)
			.max(5)
			.parse(row.source_ids),
	};
}

type CommandReceipt =
	| { readonly kind: "claimed" }
	| { readonly kind: "processing" }
	| { readonly kind: "done"; readonly response: AgentTaskToolResponse };

/** Batch verification requirements live in the existing owner-scoped durable launch journal, not model-written summaries. */
export async function assignedTaskVerification(
	userId: string,
	projectId: string,
	taskId: string,
) {
	const result = await database().query<{ assignment: unknown }>(
		`select jsonb_build_object('commands',(t->'focusedChecks') || (r.response->'result'->'finalVerification'->'perBuilderChecks'),
		 'sourcePaths',t->'verificationPaths','finalChecks',r.response->'result'->'finalVerification'->'commands') as assignment
		 from agent_task_command_receipt r join agent_session s on s.parent_session_id=r.parent_session_id
		 cross join lateral jsonb_array_elements(case when jsonb_typeof(r.response->'result'->'tasks')='array'
		 then r.response->'result'->'tasks' else '[]'::jsonb end) t
		 where s.id=$1 and s.user_id=$2 and s.project_id=$3 and r.status='done'
		 and r.response->>'ok'='true' and r.response->'result'->>'kind'='ready-task-verification-v1'
		 and t->'result'->>'taskId'=s.id::text`,
		[taskId, userId, projectId],
	);
	if (!result.rows.length) return null;
	if (result.rows.length !== 1)
		throw new Error("Task verification assignment is ambiguous.");
	return taskVerificationAssignment.parse(result.rows[0].assignment);
}

/** Retrieve only check identities from known journal calls; never send full logs or source bodies to the handoff reader. */
export async function retainedTaskCheckResults(input: {
	userId: string;
	projectId: string;
	sessionId: string;
	requestIds: readonly string[];
}) {
	if (!input.requestIds.length) return new Map<string, unknown>();
	if (input.requestIds.length > 64)
		throw new Error("Check discovery is bounded to 64 calls.");
	const result = await database().query<{
		request_id: string;
		checks: unknown;
	}>(
		`select r.request_id,
		 (select coalesce(jsonb_agg(jsonb_build_object(
		 'command',c->'command','reference',c->'reference','exitCode',c->'exitCode','stopped',c->'stopped')), '[]'::jsonb)
		 from jsonb_array_elements(case when jsonb_typeof(r.response->'result')='array'
		 then r.response->'result' else '[]'::jsonb end) c) as checks
		 from agent_task_command_receipt r join agent_session s on s.id=r.parent_session_id
		 where s.id=$1 and s.user_id=$2 and s.project_id=$3
		 and r.request_id=any($4::text[]) and r.status='done' and r.response->>'ok'='true'`,
		[input.sessionId, input.userId, input.projectId, input.requestIds],
	);
	return new Map(result.rows.map((row) => [row.request_id, row.checks]));
}

/**
 * A tool request ID belongs to one session. A repeated observation must reuse
 * its recorded response, never repeat a VM creation or publication side effect.
 */
export async function claimAgentTaskCommand(
	parentSessionId: string,
	requestId: string,
): Promise<CommandReceipt> {
	const inserted = await database().query(
		`insert into agent_task_command_receipt(parent_session_id,request_id,status)
		 values($1,$2,'processing') on conflict do nothing returning request_id`,
		[parentSessionId, requestId],
	);
	if (inserted.rowCount) return { kind: "claimed" };
	const expired: AgentTaskToolResponse = {
		id: requestId,
		ok: false,
		error:
			"The control plane restarted while this operation was in progress. Its outcome is uncertain; inspect the task before retrying with a new request.",
	};
	await database().query(
		`update agent_task_command_receipt
		 set status='done',response=$3,completed_at=now(),updated_at=now()
		 where parent_session_id=$1 and request_id=$2
		 and status='processing' and updated_at < now() - interval '30 seconds'`,
		[parentSessionId, requestId, JSON.stringify(expired)],
	);
	const existing = await database().query(
		`select status,response from agent_task_command_receipt
		 where parent_session_id=$1 and request_id=$2`,
		[parentSessionId, requestId],
	);
	const row = existing.rows[0] as
		| { status: "processing" | "done"; response: AgentTaskToolResponse | null }
		| undefined;
	if (row?.status === "done" && row.response) {
		return { kind: "done", response: row.response };
	}
	return { kind: "processing" };
}

export async function completeAgentTaskCommand(
	parentSessionId: string,
	response: AgentTaskToolResponse,
) {
	await database().query(
		`update agent_task_command_receipt
		 set status='done',response=$3,completed_at=now(),updated_at=now()
		 where parent_session_id=$1 and request_id=$2`,
		[parentSessionId, response.id, JSON.stringify(response)],
	);
}

export async function renewAgentTaskCommandClaim(
	parentSessionId: string,
	requestId: string,
) {
	await database().query(
		`update agent_task_command_receipt set updated_at=now()
		 where parent_session_id=$1 and request_id=$2 and status='processing'`,
		[parentSessionId, requestId],
	);
}
