import type { AgentTaskToolResponse } from "#/domain/agent-task-tool";
import { database } from "./database";

type CommandReceipt =
	| { readonly kind: "claimed" }
	| { readonly kind: "processing" }
	| { readonly kind: "done"; readonly response: AgentTaskToolResponse };

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
