import { createHash } from "node:crypto";
import type { ModelMessage } from "ai";
import type { PoolClient } from "pg";
import type { SessionItem } from "#/domain/session-item";
import { database } from "./database";

export type ConversationPoint = {
	type: "conversation-point";
	userMessageId: string;
	prompt: string;
	items: readonly SessionItem[];
	messages: ModelMessage[];
	modelId: string;
	routeId: string;
	revision: string;
	code?: {
		cwd: string;
		tree: string;
		indexTree: string;
		head: string;
		ref: string;
	};
};
const transcriptFingerprint = (items: unknown) =>
	createHash("sha256").update(JSON.stringify(items)).digest("hex");

/** Called inside turn admission's session lock, before the new prompt can execute. */
export async function recordConversationPoint(
	client: Pick<PoolClient, "query">,
	input: {
		userId: string;
		sessionId: string;
		items: readonly SessionItem[];
		messages: ModelMessage[];
		modelId: string;
		routeId: string;
		revision: string;
	},
) {
	let index = input.items.length - 1;
	while (index >= 0 && input.items[index].kind !== "userMessage") index--;
	const message = input.items[index];
	if (message?.kind !== "userMessage" || input.messages.at(-1)?.role !== "user")
		return;
	const active = await client.query(
		`select r.response->'result' as head,s.items from agent_task_command_receipt r join agent_session s on s.id=r.parent_session_id where s.user_id=$1 and s.id=$2 and r.request_id='conversation-head'`,
		[input.userId, input.sessionId],
	);
	const head = active.rows[0]?.head;
	if (
		head &&
		head.fingerprint === transcriptFingerprint(active.rows[0].items) &&
		head.fingerprint !== transcriptFingerprint(input.items.slice(0, index))
	)
		throw new Error(
			"The conversation was restored before this prompt was admitted. Reload the chat and retry.",
		);
	const point: ConversationPoint = {
		type: "conversation-point",
		userMessageId: message.id,
		prompt: message.text,
		items: input.items.slice(0, index),
		messages: input.messages.slice(0, -1),
		modelId: input.modelId,
		routeId: input.routeId,
		revision: input.revision,
	};
	const key = `conversation-point:${message.id}`;
	await client.query(
		`insert into agent_task_command_receipt(parent_session_id,request_id,status,response,completed_at)
    select id,$3,'done',$4::jsonb,now() from agent_session where id=$1 and user_id=$2
    on conflict(parent_session_id,request_id) do nothing`,
		[
			input.sessionId,
			input.userId,
			key,
			JSON.stringify({ id: key, ok: true, result: point }),
		],
	);
}

export async function conversationPoint(
	userId: string,
	sessionId: string,
	messageId: string,
	client: Pick<PoolClient, "query"> = database(),
) {
	const { rows } = await client.query(
		`select r.response->'result' as point from agent_task_command_receipt r
    join agent_session s on s.id=r.parent_session_id where s.user_id=$1 and s.id=$2 and r.request_id=$3 and r.status='done' and r.response->>'ok'='true'`,
		[userId, sessionId, `conversation-point:${messageId}`],
	);
	const point = rows[0]?.point as ConversationPoint | undefined;
	return point?.type === "conversation-point" ? point : null;
}

export async function recoveredConversation(
	userId: string,
	sessionId: string,
	modelId: string,
	revision: string,
) {
	const { rows } = await database().query(
		`select r.response->'result' as head,s.items from agent_task_command_receipt r
    join agent_session s on s.id=r.parent_session_id where s.user_id=$1 and s.id=$2 and r.request_id='conversation-head' and r.status='done'`,
		[userId, sessionId],
	);
	const row = rows[0];
	const head = row?.head as
		| {
				fingerprint: string;
				modelId: string;
				revision: string;
				messages: ModelMessage[];
		  }
		| undefined;
	if (!head || head.fingerprint !== transcriptFingerprint(row.items))
		return null;
	return {
		messages:
			head.modelId === modelId && head.revision === revision
				? head.messages
				: null,
	};
}

export async function saveRecoveredConversation(
	client: Pick<PoolClient, "query">,
	userId: string,
	sessionId: string,
	point: ConversationPoint,
) {
	await client.query(
		`update agent_session set items=$3::jsonb,turn_status='idle',task_summary=null,task_review_state=case when parent_session_id is null then null else 'pending' end,updated_at=now() where user_id=$1 and id=$2`,
		[userId, sessionId, JSON.stringify(point.items)],
	);
	const result = {
		fingerprint: transcriptFingerprint(point.items),
		messages: point.messages,
		modelId: point.modelId,
		revision: point.revision,
	};
	await client.query(
		`insert into agent_task_command_receipt(parent_session_id,request_id,status,response,completed_at)
    select id,'conversation-head','done',$3::jsonb,now() from agent_session where user_id=$1 and id=$2
    on conflict(parent_session_id,request_id) do update set response=excluded.response,status='done',completed_at=now(),updated_at=now()`,
		[
			userId,
			sessionId,
			JSON.stringify({ id: "conversation-head", ok: true, result }),
		],
	);
}
