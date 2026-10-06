import { createHash, randomUUID } from "node:crypto";
import { database } from "./database";

export type AgentTaskEventType = "completed" | "failed" | "blocked";

/** A synchronous integration belongs to its lead turn; a lost turn must not leave the child occupying capacity forever. */
export async function recoverInterruptedTaskIntegrations() {
	const message =
		"The lead turn ended before server integration finalized. Inspect the preserved checkout and command evidence before agent repair; uncertain operations were not replayed.";
	await database().query(
		`with interrupted as (
		 update agent_session c set task_state='failed',turn_status='failed',task_summary=$1::text,updated_at=now(),
		 items=c.items || jsonb_build_array(jsonb_build_object('kind','error','id',c.id::text || ':interrupted-integration','message',$1::text))
		 from api_turn t
		 where c.parent_session_id=t.session_id and c.user_id=t.user_id and c.task_state='working'
		 and c.turn_status='running' and t.state in ('completed','failed','cancelled')
		 and c.items->0->>'kind'='userMessage' and c.items->0->>'id'=t.id::text || ':integration'
		 and not exists(select 1 from api_turn active where active.session_id=c.id and active.state in ('queued','running'))
		 returning c.id,c.user_id,c.parent_session_id,c.items->0->>'id' as origin
		 ) insert into agent_task_event(id,user_id,parent_session_id,child_session_id,event_type,dedupe_key,payload)
		 select gen_random_uuid(),user_id,parent_session_id,id,'failed',id::text || ':failed:' || origin,jsonb_build_object('message',$1::text) from interrupted
		 on conflict(dedupe_key) do nothing`,
		[message],
	);
}

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
			JSON.stringify({ message: summary }),
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
	const result = await database().query<{ id: string }>(
		`with task as (
		 update agent_session
		 set task_state='waiting', turn_status='idle', updated_at=now()
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
		select id from inserted`,
		[
			input.sessionId,
			eventId,
			dedupeKey,
			JSON.stringify({ message: question }),
		],
	);
	if (!result.rows[0]) return null;
	return result.rows[0].id;
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

export async function deferAgentTaskEvent(eventId: string, message: string) {
	await database().query(
		`update agent_task_event
		 set status='pending', available_at=now() + interval '15 seconds', last_error=$2
		 where id=$1`,
		[eventId, message.slice(0, 1_000)],
	);
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
