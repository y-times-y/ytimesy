import type { AgentTaskToolResponse } from "#/domain/agent-task-tool";
import { database } from "./database";

export async function completedLifecycleContinuations(
	sessionId: string,
	turnId: string,
) {
	const { rows } = await database().query(
		`select count(*)::int as count from agent_task_command_receipt where parent_session_id=$1 and starts_with(request_id,$2) and status='done' and response->>'ok'='true' and response->'result'->>'continue'='true'`,
		[sessionId, `${turnId}:lifecycle-stop-decision:`],
	);
	return Number(rows[0]?.count ?? 0);
}

type CommandReceipt =
	| { readonly kind: "claimed" }
	| { readonly kind: "processing" }
	| { readonly kind: "done"; readonly response: AgentTaskToolResponse };

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
	const renewed = await database().query(
		`update agent_task_command_receipt set updated_at=now()
		 where parent_session_id=$1 and request_id=$2 and status='processing'`,
		[parentSessionId, requestId],
	);
	if (!renewed.rowCount)
		throw new Error("The command journal claim is no longer processing.");
}
