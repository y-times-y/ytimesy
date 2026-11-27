import { createHash, randomUUID } from "node:crypto";
import { jsonbText } from "#/domain/jsonb";
import { hubTopic } from "#/domain/user-hub";
import { database } from "./database";
import { noteSessionsChanged } from "./list-change-notes";
import { noteUserHub } from "./user-hub-notes";

export type AgentTaskEventType = "completed" | "failed" | "blocked";

export type AgentTaskEvent = {
	readonly id: string;
	readonly userId: string;
	readonly parentSessionId: string;
	readonly childSessionId: string;
	readonly eventType: AgentTaskEventType;
	readonly payload: { readonly message: string };
	readonly attempts: number;
};

export async function saveAgentTaskResultAndEvent(input: {
	readonly sessionId: string;
	readonly summary: string;
	readonly turnId?: string;
	readonly eventType: Extract<AgentTaskEventType, "completed" | "failed">;
}) {
	const summary = input.summary.trim();
	if (!summary) return null;
	const dedupeKey = input.turnId
		? `${input.sessionId}:${input.eventType}:${input.turnId}`
		: taskEventDedupeKey(input.sessionId, input.eventType, summary);
	const eventId = randomUUID();
	const result = await database().query<{ id: string }>(
		`with task as (
		 update agent_session
		 set task_summary=$2, updated_at=now()
		 where id=$1 and parent_session_id is not null
		 returning user_id,parent_session_id
		), inserted as (
		 insert into agent_task_event(
		  id,user_id,parent_session_id,child_session_id,event_type,dedupe_key,payload
		 )
		 select $3,user_id,parent_session_id,$1,$4,$5,$6::jsonb from task
		 on conflict(dedupe_key) do nothing
		 returning id
		)
		select id from inserted`,
		[
			input.sessionId,
			summary,
			eventId,
			input.eventType,
			dedupeKey,
			jsonbText({ message: summary }),
		],
	);
	return result.rows[0]?.id ?? null;
}

export async function saveAgentTaskBlockedEvent(input: {
	readonly sessionId: string;
	readonly question: string;
}) {
	const question = input.question.trim();
	if (!question) throw new Error("A blocked task must include its question.");
	const dedupeKey = taskEventDedupeKey(input.sessionId, "blocked", question);
	const eventId = randomUUID();
	const result = await database().query<{
		id: string;
		user_id: string;
		parent_session_id: string;
	}>(
		`with task as (
		 update agent_session
		 set task_state='waiting', turn_status=case when exists(
		  select 1 from api_turn where session_id=agent_session.id
		  and user_id=agent_session.user_id and state in ('queued','running')
		 ) then 'running' else 'idle' end, updated_at=now()
		 where id=$1 and parent_session_id is not null
		 returning user_id,parent_session_id
		), inserted as (
		 insert into agent_task_event(
		  id,user_id,parent_session_id,child_session_id,event_type,dedupe_key,payload
		 )
		 select $2,user_id,parent_session_id,$1,'blocked',$3,$4::jsonb from task
		 on conflict(dedupe_key) do nothing
		 returning id
		)
		select inserted.id,task.user_id,task.parent_session_id from inserted cross join task`,
		[input.sessionId, eventId, dedupeKey, jsonbText({ message: question })],
	);
	const row = result.rows[0];
	if (!row) return null;
	noteUserHub(row.user_id, [hubTopic.agents(row.parent_session_id)]);
	noteSessionsChanged(row.user_id);
	return row.id;
}

export async function claimAgentTaskEvent(eventId?: string) {
	const result = await database().query<AgentTaskEventRow>(
		`update agent_task_event
		 set status='delivering', attempts=attempts+1, last_error=null,
		     available_at=now() + interval '5 minutes'
		 where id=(
		  select id from agent_task_event
		  where status in ('pending','delivering') and available_at <= now()
		    and ($1::uuid is null or id=$1)
		  order by created_at
		  for update skip locked
		  limit 1
		 )
		 returning id,user_id,parent_session_id,child_session_id,event_type,payload,attempts`,
		[eventId ?? null],
	);
	return result.rows[0] ? toAgentTaskEvent(result.rows[0]) : null;
}

export async function markAgentTaskEventDelivered(eventId: string) {
	await database().query(
		`update agent_task_event
		 set status='delivered', delivered_at=now(), last_error=null
		 where id=$1`,
		[eventId],
	);
}

/**
 * A chat's turn ended: the reports held back while it ran (deferred by
 * deliverParentTaskNotification) are due now. Returns how many.
 */
export async function releaseHeldAgentTaskEvents(parentSessionId: string) {
	const result = await database().query(
		`update agent_task_event set available_at=now()
		 where parent_session_id=$1 and status='pending' and available_at > now()`,
		[parentSessionId],
	);
	return result.rowCount ?? 0;
}

/**
 * Puts a claimed event back for a later try. False when a waiter took it
 * meanwhile (takeSubagentReport, the attempt loop): a taken report is never
 * resurrected, and the caller retracts what it staged.
 */
export async function deferAgentTaskEvent(eventId: string, message: string) {
	const result = await database().query(
		`update agent_task_event
		 set status='pending', available_at=now() + interval '15 seconds', last_error=$2
		 where id=$1 and status='delivering'`,
		[eventId, message.slice(0, 1_000)],
	);
	return (result.rowCount ?? 0) > 0;
}

function taskEventDedupeKey(
	sessionId: string,
	eventType: AgentTaskEventType,
	message: string,
) {
	const digest = createHash("sha256")
		.update(message)
		.digest("hex")
		.slice(0, 24);
	return `${sessionId}:${eventType}:${digest}`;
}

type AgentTaskEventRow = {
	id: string;
	user_id: string;
	parent_session_id: string;
	child_session_id: string;
	event_type: AgentTaskEventType;
	payload: { message?: unknown };
	attempts: number;
};

function toAgentTaskEvent(row: AgentTaskEventRow): AgentTaskEvent {
	return {
		id: row.id,
		userId: row.user_id,
		parentSessionId: row.parent_session_id,
		childSessionId: row.child_session_id,
		eventType: row.event_type,
		payload: {
			message:
				typeof row.payload?.message === "string" ? row.payload.message : "",
		},
		attempts: row.attempts,
	};
}

/**
 * A child's report events (completed or failed) created since `since`,
 * oldest first, with whether delivery still owes them to the parent
 * (lead mode fusion: the lead waits for its sidekick round's report).
 */
export async function childReportEventsSince(
	childSessionId: string,
	since: string,
) {
	const result = await database().query<AgentTaskEventRow & { status: string }>(
		`select id,user_id,parent_session_id,child_session_id,event_type,payload,attempts,status
		 from agent_task_event
		 where child_session_id=$1 and event_type in ('completed','failed') and created_at >= $2::timestamptz
		 order by created_at`,
		[childSessionId, since],
	);
	return result.rows.map((row) => ({
		...toAgentTaskEvent(row),
		pending: row.status === "pending" || row.status === "delivering",
	}));
}
