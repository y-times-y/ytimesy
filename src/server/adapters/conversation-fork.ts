import type { PoolClient } from "pg";
import {
	CONVERSATION_FORK_REQUEST_ID,
	CONVERSATION_FORK_STALE_SECONDS,
	type ConversationForkJournal,
} from "#/domain/conversation-fork";
import { jsonbText } from "#/domain/jsonb";
import { hubTopic } from "#/domain/user-hub";
import { database } from "./database";
import { noteUserHub } from "./user-hub-notes";

/** Opens a fork's journal in the transaction that makes its chat row. */
export async function openConversationForkJournal(
	client: Pick<PoolClient, "query">,
	sessionId: string,
	journal: ConversationForkJournal,
) {
	await client.query(
		`insert into agent_task_command_receipt(parent_session_id,request_id,status,response,completed_at)
		 values($1,$2,'done',$3::jsonb,now())`,
		[sessionId, CONVERSATION_FORK_REQUEST_ID, jsonbText(journal)],
	);
}

export async function conversationForkJournal(
	userId: string,
	sessionId: string,
	projectId?: string,
): Promise<{ journal: ConversationForkJournal; updatedAt: Date } | null> {
	const result = await database().query<{
		response: ConversationForkJournal;
		updated_at: Date;
	}>(
		`select r.response,r.updated_at from agent_task_command_receipt r join agent_session s on s.id=r.parent_session_id
		 where s.id=$1 and s.user_id=$2 and ($3::uuid is null or s.project_id=$3::uuid) and r.request_id=$4`,
		[sessionId, userId, projectId ?? null, CONVERSATION_FORK_REQUEST_ID],
	);
	const row = result.rows[0];
	return row
		? { journal: row.response, updatedAt: new Date(row.updated_at) }
		: null;
}

/** A chat whose forked VM is not bound yet must not get a VM of its own. */
export async function conversationForkPending(sessionId: string) {
	const result = await database().query<{ pending: boolean }>(
		"select exists(select 1 from agent_task_command_receipt where parent_session_id=$1 and request_id=$2) as pending",
		[sessionId, CONVERSATION_FORK_REQUEST_ID],
	);
	return result.rows[0]?.pending ?? false;
}

/**
 * Binds the copied VM to the fork and closes its journal, only for the
 * current attempt of a chat that has no VM yet. False: a retry superseded
 * this attempt, or the chat is gone.
 */
export async function bindConversationForkVm(
	userId: string,
	sessionId: string,
	attempt: number,
	vm: string,
) {
	const result = await database().query(
		`with bound as (update agent_session s set provider_ref=$3,status='ready',updated_at=now()
		 where s.id=$1 and s.user_id=$2 and s.provider_ref is null
		 and exists(select 1 from agent_task_command_receipt r where r.parent_session_id=s.id and r.request_id=$5
		  and r.response->>'state'='preparing' and (r.response->>'attempt')::int=$4)
		 returning s.id)
		 delete from agent_task_command_receipt r using bound where r.parent_session_id=bound.id and r.request_id=$5`,
		[sessionId, userId, vm, attempt, CONVERSATION_FORK_REQUEST_ID],
	);
	const bound = (result.rowCount ?? 0) > 0;
	if (bound) noteUserHub(userId, [hubTopic.fork(sessionId)]);
	return bound;
}

/** Records the attempt's failure for the chat to show; a superseded attempt writes nothing. */
export async function failConversationFork(
	userId: string,
	sessionId: string,
	journal: ConversationForkJournal,
	failure: { readonly message: string; readonly leftoverVm?: string },
) {
	const failed: ConversationForkJournal = {
		...journal,
		state: "failed",
		message: failure.message,
		...(failure.leftoverVm ? { leftoverVm: failure.leftoverVm } : {}),
	};
	await database().query(
		`update agent_task_command_receipt r set response=$4::jsonb,updated_at=now()
		 from agent_session s where s.id=r.parent_session_id and s.id=$1 and s.user_id=$2
		 and r.request_id=$5 and (r.response->>'attempt')::int=$3`,
		[
			sessionId,
			userId,
			journal.attempt,
			jsonbText(failed),
			CONVERSATION_FORK_REQUEST_ID,
		],
	);
	noteUserHub(userId, [hubTopic.fork(sessionId)]);
}

/**
 * Starts a new attempt of a failed (or interrupted) copy. Null when there is
 * nothing to retry: the copy is still running, or the VM is ready.
 */
export async function retryConversationForkJournal(
	userId: string,
	projectId: string,
	sessionId: string,
): Promise<number | null> {
	const result = await database().query<{ attempt: number }>(
		`update agent_task_command_receipt r set response=jsonb_set(jsonb_set(r.response - 'message','{state}','"preparing"'),
		  '{attempt}',to_jsonb((r.response->>'attempt')::int+1)),updated_at=now()
		 from agent_session s where s.id=r.parent_session_id and s.id=$1 and s.user_id=$2 and s.project_id=$3
		 and r.request_id=$4 and s.provider_ref is null
		 and (r.response->>'state'='failed' or r.updated_at < now()-make_interval(secs => $5::double precision))
		 returning (r.response->>'attempt')::int as attempt`,
		[
			sessionId,
			userId,
			projectId,
			CONVERSATION_FORK_REQUEST_ID,
			CONVERSATION_FORK_STALE_SECONDS,
		],
	);
	return result.rows[0]?.attempt ?? null;
}
