import { createHash } from "node:crypto";
import type { ModelMessage } from "ai";
import type { PoolClient } from "pg";
import { jsonbText } from "#/domain/jsonb";
import type { SessionItem } from "#/domain/session-item";
import {
	checkpointStorageConfigured,
	downloadCheckpoint,
	uploadCheckpoint,
} from "./checkpoints/storage";
import { database } from "./database";

/**
 * A point as stored: older points hold their transcript and messages inline;
 * newer ones hold the messages in private object storage (messagesObject)
 * and no transcript (the chat's transcript before the message is the point's,
 * read at restore); migrated ones hold both in one object (bodyObject). The
 * database keeps only the small rest.
 */
type StoredConversationPoint = Omit<ConversationPoint, "items" | "messages"> & {
	items?: readonly SessionItem[];
	messages?: ModelMessage[];
	messagesObject?: string;
	bodyObject?: string;
};

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
		/** The send appends these to the stored transcript (it never read it). */
		appendItems?: readonly SessionItem[];
		messages: ModelMessage[];
		/** The point's messages, already in private storage (storePointMessages). */
		messagesObject?: string | null;
		modelId: string;
		routeId: string;
		revision: string;
	},
) {
	if (input.appendItems) return recordAppendedPoint(client, input);
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
	const point: StoredConversationPoint = {
		type: "conversation-point",
		userMessageId: message.id,
		prompt: message.text,
		// With the messages in private storage, the point keeps no copy of the
		// transcript either: the stored transcript before the message is it
		// (read at restore). Without storage, both stay inline as before.
		...(input.messagesObject
			? { messagesObject: input.messagesObject }
			: {
					items: input.items.slice(0, index),
					messages: input.messages.slice(0, -1),
				}),
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
			jsonbText({ id: key, ok: true, result: point }),
		],
	);
}

/**
 * The point of a send that appends its message: the transcript before it is
 * the stored one, so the database copies it into the point itself (the send
 * never read it). No restore can land in between: the append and this insert
 * share the chat row's lock and apply to whatever the transcript is then.
 */
async function recordAppendedPoint(
	client: Pick<PoolClient, "query">,
	input: {
		userId: string;
		sessionId: string;
		appendItems?: readonly SessionItem[];
		messages: ModelMessage[];
		messagesObject?: string | null;
		modelId: string;
		routeId: string;
		revision: string;
	},
) {
	const message = [...(input.appendItems ?? [])]
		.reverse()
		.find((item) => item.kind === "userMessage");
	if (message?.kind !== "userMessage" || input.messages.at(-1)?.role !== "user")
		return;
	const key = `conversation-point:${message.id}`;
	const point: StoredConversationPoint = {
		type: "conversation-point",
		userMessageId: message.id,
		prompt: message.text,
		...(input.messagesObject
			? { messagesObject: input.messagesObject }
			: { messages: input.messages.slice(0, -1) }),
		modelId: input.modelId,
		routeId: input.routeId,
		revision: input.revision,
	};
	// Without private storage the point keeps the transcript inline, copied
	// in the database from the stored one (the send never read it).
	await client.query(
		`insert into agent_task_command_receipt(parent_session_id,request_id,status,response,completed_at)
    select id,$3,'done',jsonb_build_object('id',$3::text,'ok',true,'result',
      $4::jsonb || case when $5::boolean then '{}'::jsonb else jsonb_build_object('items',coalesce(items,'[]'::jsonb)) end),now()
    from agent_session where id=$1 and user_id=$2
    on conflict(parent_session_id,request_id) do nothing`,
		[
			input.sessionId,
			input.userId,
			key,
			jsonbText(point),
			Boolean(input.messagesObject),
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
	const stored = rows[0]?.point as StoredConversationPoint | undefined;
	return stored?.type === "conversation-point"
		? resolvedPoint(userId, sessionId, stored, client)
		: null;
}

/**
 * A stored point with its transcript and messages, wherever they are kept.
 * Null when they can no longer be had (the message left the transcript, or
 * its stored messages are gone): the point cannot be restored.
 */
async function resolvedPoint(
	userId: string,
	sessionId: string,
	stored: StoredConversationPoint,
	client: Pick<PoolClient, "query">,
): Promise<ConversationPoint | null> {
	let items = Array.isArray(stored.items) ? stored.items : null;
	let messages = Array.isArray(stored.messages) ? stored.messages : null;
	try {
		if (stored.bodyObject && (!items || !messages)) {
			const body = JSON.parse(
				await downloadCheckpoint(userId, sessionId, stored.bodyObject),
			) as { items?: SessionItem[]; messages?: ModelMessage[] };
			items ??= Array.isArray(body.items) ? body.items : null;
			messages ??= Array.isArray(body.messages) ? body.messages : null;
		}
		if (!messages && stored.messagesObject) {
			const body = JSON.parse(
				await downloadCheckpoint(userId, sessionId, stored.messagesObject),
			);
			messages = Array.isArray(body) ? body : null;
		}
	} catch {
		return null;
	}
	items ??= await transcriptBefore(
		userId,
		sessionId,
		stored.userMessageId,
		client,
	);
	if (!items || !messages) return null;
	const { messagesObject: _m, bodyObject: _b, ...rest } = stored;
	return { ...rest, items, messages };
}

/** The chat's transcript before the item `messageId`; null once it left it. */
async function transcriptBefore(
	userId: string,
	sessionId: string,
	messageId: string,
	client: Pick<PoolClient, "query">,
): Promise<SessionItem[] | null> {
	const { rows } = await client.query(
		`with s as (select id from agent_session where id=$2 and user_id=$1),
		 m as (select min(i.position) as at from agent_session_item i, s where i.session_id=s.id and i.item_id=$3)
		 select m.at, (select coalesce(jsonb_agg(i.item order by i.position),'[]'::jsonb)
		  from agent_session_item i, s where i.session_id=s.id and i.position < m.at) as items from m`,
		[userId, sessionId, messageId],
	);
	const row = rows[0] as
		| { at: number | null; items: SessionItem[] }
		| undefined;
	return row && row.at !== null && Array.isArray(row.items) ? row.items : null;
}

/**
 * Puts a send's point messages (the model's context before the message) in
 * private object storage before its transaction, so the point's row stays
 * small. Null when storage is not set up or the upload failed: the point
 * then keeps them inline, as before.
 */
export async function storePointMessages(input: {
	userId: string;
	sessionId: string;
	messageId: string | undefined;
	messages: readonly ModelMessage[];
}): Promise<string | null> {
	if (!input.messageId || !checkpointStorageConfigured()) return null;
	const name = `conversation-point-${input.messageId.replaceAll(/[^a-zA-Z0-9-]/g, "-")}`;
	return uploadCheckpoint(
		input.userId,
		input.sessionId,
		name,
		JSON.stringify(input.messages.slice(0, -1)),
	).catch(() => null);
}

/**
 * Whether the message has a saved recovery point and whether it already has
 * its code, without loading the point's transcript (megabytes on a long chat,
 * and this is asked on every turn).
 */
export async function conversationPointState(
	userId: string,
	sessionId: string,
	messageId: string,
	client: Pick<PoolClient, "query"> = database(),
): Promise<{ exists: boolean; hasCode: boolean }> {
	const { rows } = await client.query(
		`select r.response->'result'->>'type' as type,
    coalesce(jsonb_typeof(r.response->'result'->'code'),'null') as code_type
    from agent_task_command_receipt r
    join agent_session s on s.id=r.parent_session_id where s.user_id=$1 and s.id=$2 and r.request_id=$3 and r.status='done' and r.response->>'ok'='true'`,
		[userId, sessionId, `conversation-point:${messageId}`],
	);
	const row = rows[0] as { type?: string; code_type?: string } | undefined;
	return {
		exists: row?.type === "conversation-point",
		// Matches `point.code` being truthy: a stored object, never null.
		hasCode: row?.type === "conversation-point" && row.code_type === "object",
	};
}

/** Only the recorded code ref, without loading the point's transcript. */
export async function conversationPointCodeRef(
	userId: string,
	sessionId: string,
	messageId: string,
): Promise<string | undefined> {
	const { rows } = await database().query(
		`select r.response->'result'->'code'->>'ref' as ref from agent_task_command_receipt r
    join agent_session s on s.id=r.parent_session_id where s.user_id=$1 and s.id=$2 and r.request_id=$3 and r.status='done' and r.response->>'ok'='true'`,
		[userId, sessionId, `conversation-point:${messageId}`],
	);
	const ref = rows[0]?.ref;
	return typeof ref === "string" &&
		/^refs\/ytimesy\/recovery\/[a-zA-Z0-9-]+$/.test(ref)
		? ref
		: undefined;
}

/** The model history a restored conversation continues from, while its transcript is unchanged since. */
export async function recoveredConversation(userId: string, sessionId: string) {
	// The head's messages are a full copy of the model history (megabytes on a
	// long chat) and it matches only until the transcript changes, so read its
	// small fields first and the messages only when it still matches.
	const { rows } = await database().query(
		`select r.response->'result'->>'fingerprint' as fingerprint,s.items from agent_task_command_receipt r
    join agent_session s on s.id=r.parent_session_id where s.user_id=$1 and s.id=$2 and r.request_id='conversation-head' and r.status='done'`,
		[userId, sessionId],
	);
	const row = rows[0];
	if (
		typeof row?.fingerprint !== "string" ||
		row.fingerprint !== transcriptFingerprint(row.items)
	)
		return null;
	const { rows: heads } = await database().query(
		`select r.response->'result' as head from agent_task_command_receipt r
    join agent_session s on s.id=r.parent_session_id where s.user_id=$1 and s.id=$2 and r.request_id='conversation-head' and r.status='done'`,
		[userId, sessionId],
	);
	const head = heads[0]?.head as
		| {
				fingerprint: string;
				modelId: string;
				revision: string;
				messages: ModelMessage[];
		  }
		| undefined;
	// The head was replaced between the two reads: it is not this transcript's.
	if (!head || head.fingerprint !== row.fingerprint) return null;
	return {
		messages: head.messages,
		modelId: head.modelId,
		revision: head.revision,
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
		[userId, sessionId, jsonbText(point.items)],
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
			jsonbText({ id: "conversation-head", ok: true, result }),
		],
	);
}

/**
 * For a message whose turn never touched the workspace (no code point): the
 * code point of the first later message that has one, and whether a code
 * restore ran after the message (up to that point, or up to now when there is
 * none), which would make the later code not the message's.
 */
export async function laterConversationCode(
	userId: string,
	sessionId: string,
	messageId: string,
	laterMessageIds: readonly string[],
): Promise<{
	code: NonNullable<ConversationPoint["code"]> | null;
	rewound: boolean;
}> {
	const ids = [messageId, ...laterMessageIds].map(
		(id) => `conversation-point:${id}`,
	);
	const { rows } = await database().query(
		`select r.request_id,r.created_at,r.response->'result'->'code' as code from agent_task_command_receipt r
    join agent_session s on s.id=r.parent_session_id where s.user_id=$1 and s.id=$2 and r.request_id=any($3::text[]) and r.status='done' and r.response->>'ok'='true'`,
		[userId, sessionId, ids],
	);
	const byId = new Map(
		rows.map(
			(row: {
				request_id: string;
				created_at: Date;
				code: ConversationPoint["code"] | null;
			}) => [row.request_id, row],
		),
	);
	const own = byId.get(ids[0]);
	if (!own) return { code: null, rewound: false };
	const later = ids
		.slice(1)
		.map((id) => byId.get(id))
		.find((row) => row?.code);
	const restores = await database().query(
		`select 1 from agent_task_command_receipt where parent_session_id=$1 and request_id like 'conversation-backup:%'
    and response->'result'->'code' is not null and created_at>$2 and ($3::timestamptz is null or created_at<$3) limit 1`,
		[sessionId, own.created_at, later?.created_at ?? null],
	);
	return { code: later?.code ?? null, rewound: restores.rows.length > 0 };
}
