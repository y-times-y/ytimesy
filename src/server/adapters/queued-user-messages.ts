import type { AgentProviderId } from "#/domain/agent-provider";
import { jsonbText } from "#/domain/jsonb";
import type { UserMessageItem } from "#/domain/session-item";
import { wakeConversationProgress } from "./conversation-progress-wake";
import { database } from "./database";
import { forgetPeerInboxObservation } from "./peer-inbox-observation";

/** A composer send waiting in the chat's inbox while a turn runs. */
export type QueuedUserSend = {
	/** The timeline message, with its attachments already in private storage. */
	readonly item: UserMessageItem;
	/** What the model reads for it (the text plus its attachment note). */
	readonly message: string;
	/** The route and settings a turn it starts uses. */
	readonly harnessId: AgentProviderId;
	readonly modelId: string;
	readonly variant?: string;
	readonly speed?: "standard" | "fast" | "ultrafast";
	readonly fast?: boolean;
	/**
	 * Send was pressed. Absent or false waits for Send or the turn's end;
	 * true is taken at the next model step.
	 */
	readonly released?: boolean;
	/** A new chat's first send: the branch it starts from (held for setup). */
	readonly baseBranch?: string;
	/** Sent from "Set up environment", or "Set up with the agent" on a held message. */
	readonly environmentSetup?: boolean;
};

/**
 * A waiting row held until the project's environment is ready (its item says
 * so): no turn end, Send or model step takes it; the environment becoming
 * ready releases it (releaseHeldUserMessages).
 */
export const heldForSetupSql = `coalesce(q.queued_send->'item'->>'heldForSetup','')='true'`;

/** A waiting message as the timeline sees it. `released` is set only after Send. */
export const queuedTimelineItemSql = `case when q.queued_send->>'released' = 'true' then jsonb_set(q.queued_send->'item', '{released}', 'true'::jsonb) else q.queued_send->'item' end`;

const inboxId = (messageId: string) => `queued-user:${messageId}`;

/**
 * Queues the send only while the chat's turn is running. The session row lock
 * orders it against the turn's end: a turn that already ended returns
 * "not-running" (the caller starts a turn), and one that ends after this
 * commits finds the message waiting. Touching `items` republishes the chat.
 */
export async function queueUserMessageWhileRunning(
	userId: string,
	sessionId: string,
	send: QueuedUserSend,
): Promise<"queued" | "not-running"> {
	const { message, ...stored } = send;
	const result = await database().query<{ running: number }>(
		`with s as (update agent_session set items=items where id=$1 and user_id=$2 and turn_status='running' returning id),
		 queued as (insert into agent_peer_inbox(id,recipient_id,message,queued_send)
		  select $3,s.id,$4,$5::jsonb from s on conflict(id) do nothing returning id)
		 select (select count(*) from s)::int as running`,
		[sessionId, userId, inboxId(send.item.id), message, jsonbText(stored)],
	);
	if (!result.rows[0]?.running) return "not-running";
	forgetPeerInboxObservation(sessionId);
	await wakeConversationProgress();
	return "queued";
}

/** The chat's waiting messages, oldest first, for its public timeline. */
export async function queuedUserMessageItems(
	sessionId: string,
): Promise<UserMessageItem[]> {
	const result = await database().query<{ item: UserMessageItem }>(
		`select ${queuedTimelineItemSql} as item from agent_peer_inbox q
		 where q.recipient_id=$1 and not q.accepted and q.queued_send is not null order by q.created_at,q.id`,
		[sessionId],
	);
	return result.rows.map((row) => row.item);
}

/** Only a message no step has taken yet can be removed. */
export async function removeQueuedUserMessage(
	userId: string,
	sessionId: string,
	messageId: string,
): Promise<boolean> {
	const result = await database().query(
		`with removed as (delete from agent_peer_inbox q using agent_session s
		  where q.id=$3 and q.recipient_id=s.id and s.id=$1 and s.user_id=$2
		  and not q.accepted and q.queued_send is not null returning q.recipient_id)
		 update agent_session set items=items where id in (select recipient_id from removed) returning id`,
		[sessionId, userId, inboxId(messageId)],
	);
	if (!result.rowCount) return false;
	forgetPeerInboxObservation(sessionId);
	await wakeConversationProgress();
	return true;
}

/** Rewrites a waiting message. A step that already took it is left alone. */
export async function updateQueuedUserMessage(
	userId: string,
	sessionId: string,
	messageId: string,
	text: string,
	modelMessage: string,
	/** "Set up with the agent" on a held message: it goes as a setup chat's request. */
	environmentSetup = false,
): Promise<boolean> {
	const result = await database().query(
		`with edited as (
		  update agent_peer_inbox q
		  set message=$4,
		      queued_send=jsonb_set(q.queued_send, '{item,text}', to_jsonb($5::text))
		        || case when $6::boolean then '{"environmentSetup":true}'::jsonb else '{}'::jsonb end
		  from agent_session s
		  where q.id=$3 and q.recipient_id=s.id and s.id=$1 and s.user_id=$2
		    and not q.accepted and q.queued_send is not null
		  returning q.recipient_id)
		 update agent_session set items=items where id in (select recipient_id from edited) returning id`,
		[
			sessionId,
			userId,
			inboxId(messageId),
			modelMessage,
			text,
			environmentSetup,
		],
	);
	if (!result.rowCount) return false;
	forgetPeerInboxObservation(sessionId);
	await wakeConversationProgress();
	return true;
}

/**
 * Send on a waiting message. While the turn runs it is marked for the next
 * model step (the in-flight tool call is not interrupted). Once nothing is
 * running, this message is taken so the caller can start its turn now.
 */
export async function releaseQueuedUserMessage(
	userId: string,
	sessionId: string,
	messageId: string,
): Promise<
	| { readonly status: "running" }
	| { readonly status: "taken"; readonly send: QueuedUserSend }
	| { readonly status: "missing" }
> {
	const result = await database().query<{
		turn_status: string;
		message: string | null;
		queued_send: Omit<QueuedUserSend, "message"> | null;
	}>(
		`with locked as (
		  select q.id, q.message, q.queued_send, s.turn_status
		  from agent_peer_inbox q
		  join agent_session s on s.id=q.recipient_id
		  where q.id=$3 and s.id=$1 and s.user_id=$2
		    and not q.accepted and q.queued_send is not null and not ${heldForSetupSql}
		  for update of q, s),
		 marked as (
		  update agent_peer_inbox q
		  set queued_send=jsonb_set(q.queued_send, '{released}', 'true'::jsonb)
		  from locked
		  where q.id=locked.id and locked.turn_status='running'
		  returning q.recipient_id),
		 touched as (
		  update agent_session set items=items
		  where id in (select recipient_id from marked)
		  returning id),
		 taken as (
		  delete from agent_peer_inbox q
		  using locked
		  where q.id=locked.id and locked.turn_status<>'running'
		  returning q.message, q.queued_send)
		 select locked.turn_status, taken.message, taken.queued_send,
		  (select count(*) from touched) as republished
		 from locked left join taken on true`,
		[sessionId, userId, inboxId(messageId)],
	);
	const row = result.rows[0];
	if (!row) return { status: "missing" };
	forgetPeerInboxObservation(sessionId);
	await wakeConversationProgress();
	if (row.turn_status === "running" || !row.queued_send || !row.message) {
		return { status: "running" };
	}
	return {
		status: "taken",
		send: { ...row.queued_send, message: row.message, released: true },
	};
}

/**
 * Takes the oldest waiting message once the chat has no running turn, so it
 * can start the next one. Racing callers take it at most once.
 */
export async function takeNextQueuedUserMessage(
	userId: string,
	sessionId: string,
): Promise<QueuedUserSend | null> {
	const result = await database().query<{
		message: string;
		queued_send: Omit<QueuedUserSend, "message">;
	}>(
		`delete from agent_peer_inbox where id=(
		  select q.id from agent_peer_inbox q join agent_session s on s.id=q.recipient_id
		  where q.recipient_id=$1 and s.user_id=$2 and s.turn_status<>'running'
		  and not q.accepted and q.queued_send is not null and not ${heldForSetupSql}
		  order by q.created_at,q.id limit 1 for update of q skip locked)
		 returning message,queued_send`,
		[sessionId, userId],
	);
	const row = result.rows[0];
	return row ? { ...row.queued_send, message: row.message } : null;
}

/** A taken message whose turn could not start goes back first in line. */
export async function restoreQueuedUserMessage(
	sessionId: string,
	send: QueuedUserSend,
) {
	const { message, ...stored } = send;
	await database().query(
		`with restored as (insert into agent_peer_inbox(id,recipient_id,message,queued_send,created_at)
		  values($1,$2,$3,$4::jsonb,'-infinity') on conflict(id) do nothing returning recipient_id)
		 update agent_session set items=items where id in (select recipient_id from restored)`,
		[inboxId(send.item.id), sessionId, message, jsonbText(stored)],
	);
	forgetPeerInboxObservation(sessionId);
	await wakeConversationProgress();
}

/**
 * Holds a send in the chat until the project's environment is ready: the
 * chat's own waiting row, so the chat lists with it, every device shows it,
 * and it goes once the environment is ready even with no tab open. A replay
 * with the same message id adds nothing. Touching `items` republishes the chat.
 */
export async function holdUserMessageForSetup(
	userId: string,
	sessionId: string,
	send: QueuedUserSend,
): Promise<boolean> {
	const { message, ...stored } = send;
	const held = {
		...stored,
		item: { ...stored.item, heldForSetup: true },
		released: false,
	};
	const result = await database().query(
		`with s as (update agent_session set items=items,updated_at=now() where id=$1 and user_id=$2 returning id),
		 held as (insert into agent_peer_inbox(id,recipient_id,message,queued_send)
		  select $3,s.id,$4,$5::jsonb from s on conflict(id) do nothing returning id)
		 select (select count(*) from s)::int as found`,
		[sessionId, userId, inboxId(send.item.id), message, jsonbText(held)],
	);
	if (!result.rows[0]?.found) return false;
	forgetPeerInboxObservation(sessionId);
	await wakeConversationProgress();
	return true;
}

/**
 * The environment is ready: the chat's held messages become ordinary waiting
 * ones, already sent (the turn they start, or the turn's end, takes them).
 * Until a turn takes it a message stays in the chat, so none is dropped.
 */
export async function releaseHeldUserMessages(sessionId: string) {
	const result = await database().query(
		`with released as (
		  update agent_peer_inbox q
		  set queued_send=jsonb_set(q.queued_send #- '{item,heldForSetup}', '{released}', 'true'::jsonb)
		  where q.recipient_id=$1 and not q.accepted and q.queued_send is not null and ${heldForSetupSql}
		  returning q.recipient_id)
		 update agent_session set items=items where id in (select recipient_id from released) returning id`,
		[sessionId],
	);
	if (!result.rowCount) return false;
	forgetPeerInboxObservation(sessionId);
	await wakeConversationProgress();
	return true;
}

/** The chat holding a send with this message id (a replayed held send finds it). */
export async function chatHoldingMessage(
	userId: string,
	projectId: string,
	messageId: string,
): Promise<string | null> {
	const result = await database().query<{ id: string }>(
		`select s.id from agent_peer_inbox q join agent_session s on s.id=q.recipient_id
		 where q.id=$3 and s.user_id=$1 and s.project_id=$2 and not q.accepted limit 1`,
		[userId, projectId, inboxId(messageId)],
	);
	return result.rows[0]?.id ?? null;
}

/**
 * Chats holding a send whose project's environment is ready: one workspace's
 * (its build just finished), or any (the periodic sweep).
 */
export async function chatsWithReleasableHeldSends(
	workspaceId?: string,
	limit = 50,
): Promise<
	{
		readonly userId: string;
		readonly sessionId: string;
		readonly workspaceId: string;
	}[]
> {
	const result = await database().query<{
		user_id: string;
		id: string;
		workspace_id: string;
	}>(
		`select distinct s.user_id, s.id, w.id::text as workspace_id from agent_peer_inbox q
		 join agent_session s on s.id=q.recipient_id
		 join workspace w on w.user_id=s.user_id and w.project_id=s.project_id
		 where not q.accepted and q.queued_send is not null and ${heldForSetupSql}
		   and w.status='ready' and (w.provider_ref is not null or w.template_snapshot_id is not null)
		   and ($1::text is null or w.id::text=$1::text)
		 limit $2`,
		[workspaceId ?? null, limit],
	);
	return result.rows.map((row) => ({
		userId: row.user_id,
		sessionId: row.id,
		workspaceId: row.workspace_id,
	}));
}
