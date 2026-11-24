import type { AgentProviderId } from "#/domain/agent-provider";
import { jsonbText } from "#/domain/jsonb";
import { MESSAGE_ATTACHMENT_LIMITS } from "#/domain/message-attachment";
import { QUEUED_MESSAGES_PER_CHAT_LIMIT } from "#/domain/peer-inbox-injection";
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
	readonly alternateContext?: boolean;
	/**
	 * Send was pressed. Absent or false waits for Send or the turn's end;
	 * true is taken at the next model step.
	 */
	readonly released?: boolean;
	/** A new chat's first send: the branch it starts from (held for setup). */
	readonly baseBranch?: string;
	/** A project setup request, or "Fix with the agent" on a held message. */
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

export const inboxId = (messageId: string) => `queued-user:${messageId}`;

/**
 * A message taken to start a turn is claimed, not deleted: its row stays (the
 * chat keeps showing it as waiting) until the turn that includes it exists,
 * when enqueueApiTurn deletes it in the same transaction that creates the
 * turn. A delivery that dies in between (a deploy or a memory reset of the
 * chat's object, a lost connection) leaves the claim, which lapses after
 * this long and is taken again. Before this the take deleted the row first:
 * a delivery that died after it lost the person's message for good
 * (2026-11-24, the Y² chat).
 */
export const QUEUED_CLAIM_TTL_MS = 60_000;

const nowMsSql = "(extract(epoch from now())*1000)::bigint";
/** Set on a row a delivery is starting a turn for. */
const claimSql = `jsonb_set(q.queued_send,'{claimedAt}',to_jsonb(${nowMsSql}))`;

/** A queued send as the delivery uses it, without the claim marker. */
function unclaimed<T extends { claimedAt?: unknown }>(
	send: T,
): Omit<T, "claimedAt"> {
	const { claimedAt: _claimedAt, ...rest } = send;
	return rest;
}

/**
 * Queues the send only while the chat's turn is running. The session row lock
 * orders it against the turn's end: a turn that already ended returns
 * "not-running" (the caller starts a turn), and one that ends after this
 * commits finds the message waiting. Touching `items` republishes the chat.
 * A chat holds at most QUEUED_MESSAGES_PER_CHAT_LIMIT waiting messages: past
 * it nothing is stored and the result is "full" (a replay of a message that
 * is already waiting is still "queued"). The count is read in the same
 * statement as the insert, so two sends at the same instant can overshoot by
 * a message or two: the cap bounds growth, it is not an exact limit.
 */
export async function queueUserMessageWhileRunning(
	userId: string,
	sessionId: string,
	send: QueuedUserSend,
): Promise<"queued" | "not-running" | "full"> {
	const { message, ...stored } = send;
	const result = await database().query<{ running: number; full: boolean }>(
		`with s as (update agent_session set items=items where id=$1 and user_id=$2 and turn_status='running' returning id),
		 waiting as (select count(*)::int as n, coalesce(bool_or(id=$3),false) as has from agent_peer_inbox where recipient_id=$1 and not accepted and queued_send is not null),
		 queued as (insert into agent_peer_inbox(id,recipient_id,message,queued_send)
		  select $3,s.id,$4,$5::jsonb from s, waiting where waiting.n < $6
		  on conflict(id) do update set queued_send=excluded.queued_send
		   where agent_peer_inbox.queued_send ? 'claimedAt' and not agent_peer_inbox.accepted
		  returning id)
		 select (select count(*) from s)::int as running,
		  (select n >= $6 and not has from waiting) as full`,
		[
			sessionId,
			userId,
			inboxId(send.item.id),
			message,
			jsonbText(stored),
			QUEUED_MESSAGES_PER_CHAT_LIMIT,
		],
	);
	if (!result.rows[0]?.running) return "not-running";
	if (result.rows[0].full) return "full";
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
	/** "Fix with the agent" on a held message: it goes as a setup chat's request. */
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
		queued_send:
			| (Omit<QueuedUserSend, "message"> & { claimedAt?: number })
			| null;
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
		  update agent_peer_inbox q
		  set queued_send=${claimSql}
		  from locked
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
		send: {
			...unclaimed(row.queued_send),
			message: row.message,
			released: true,
		},
	};
}

/**
 * What may share one turn: the same origin (the person's own messages, or one
 * sender's steering text: a different agent's never joins them), the same
 * route and settings, and no first-send fields (a setup request or a new
 * chat's base branch goes alone). Equal keys, consecutive in order, merge.
 */
const mergeKeySql = `concat_ws('|',
  coalesce(substring(q.queued_send->'item'->>'text' from '^Message from ([^\\n]+):\\n\\n'),''),
  q.queued_send->>'harnessId', q.queued_send->>'modelId', q.queued_send->>'variant',
  q.queued_send->>'speed', q.queued_send->>'fast', q.queued_send->>'alternateContext',
  case when coalesce(q.queued_send->>'environmentSetup','')='true' or q.queued_send->>'baseBranch' is not null then q.id else '' end)`;

/**
 * Takes the waiting messages that start the chat's next turn once it has no
 * running turn, oldest first, in one statement: the oldest one, then every
 * message right behind it that may share its turn (mergeKeySql), up to
 * `limit` messages (the per-chat queue cap by default) and one turn's
 * attachment limits (the first message always goes). Taking them deletes
 * them together, so they are delivered together. Racing callers take each
 * message at most once.
 */
export async function takeNextQueuedUserMessages(
	userId: string,
	sessionId: string,
	limit = QUEUED_MESSAGES_PER_CHAT_LIMIT,
): Promise<QueuedUserSend[]> {
	const result = await database().query<{
		rn: string | number;
		message: string;
		reclaimed: boolean;
		queued_send: Omit<QueuedUserSend, "message"> & { claimedAt?: number };
	}>(
		`with live as (
		  select 1 from agent_peer_inbox c
		  where c.recipient_id=$1 and not c.accepted and c.queued_send is not null
		   and coalesce((c.queued_send->>'claimedAt')::bigint,0) >= ${nowMsSql} - $6
		  limit 1),
		 eligible as (
		  select q.id, q.created_at, q.message, q.queued_send, (q.queued_send ? 'claimedAt') as reclaimed, ${mergeKeySql} as k,
		   coalesce(jsonb_array_length(q.queued_send->'item'->'attachments'),0) as files,
		   coalesce((select sum((a->>'size')::bigint) from jsonb_array_elements(coalesce(q.queued_send->'item'->'attachments','[]'::jsonb)) a),0) as bytes
		  from agent_peer_inbox q join agent_session s on s.id=q.recipient_id
		  where q.recipient_id=$1 and s.user_id=$2 and s.turn_status<>'running'
		   and not q.accepted and q.queued_send is not null and not ${heldForSetupSql}
		   and not exists(select 1 from live)
		  order by q.created_at,q.id for update of q skip locked),
		 numbered as (
		  select e.*, row_number() over w as rn, sum(files) over w as cum_files,
		   sum(bytes) over w as cum_bytes, first_value(k) over w as head_k
		  from eligible e window w as (order by created_at,id)),
		 stop as (
		  select min(rn) as at from numbered
		  where k<>head_k or rn>$3 or (rn>1 and (cum_files>$4 or cum_bytes>$5))),
		 taken as (
		  update agent_peer_inbox q set queued_send=${claimSql}
		  from numbered n, stop
		  where q.id=n.id and n.rn < coalesce(stop.at, 2147483647)
		  returning n.rn, q.message, q.queued_send, n.reclaimed)
		 select rn, message, queued_send, reclaimed from taken order by rn`,
		[
			sessionId,
			userId,
			Math.max(1, limit),
			MESSAGE_ATTACHMENT_LIMITS.files,
			MESSAGE_ATTACHMENT_LIMITS.totalBytes,
			QUEUED_CLAIM_TTL_MS,
		],
	);
	const rows = [...result.rows].sort((a, b) => Number(a.rn) - Number(b.rn));
	if (rows.length)
		console.info(
			JSON.stringify({
				event: "queued_message.claimed",
				sessionId,
				count: rows.length,
				reclaimed: rows.filter((row) => row.reclaimed).length,
			}),
		);
	return rows.map((row) => ({
		...unclaimed(row.queued_send),
		message: row.message,
	}));
}

/** The oldest waiting message alone (a held send's own delivery). */
export async function takeNextQueuedUserMessage(
	userId: string,
	sessionId: string,
): Promise<QueuedUserSend | null> {
	return (await takeNextQueuedUserMessages(userId, sessionId, 1))[0] ?? null;
}

/** A taken message whose turn could not start goes back first in line. */
export async function restoreQueuedUserMessage(
	sessionId: string,
	send: QueuedUserSend,
) {
	await restoreQueuedUserMessages(sessionId, [send]);
}

/**
 * Taken messages whose turn could not start go back, still in their order and
 * ahead of everything waiting: their rows are still there (taking only claimed
 * them), so the claim is lifted; a row that is gone (an older take deleted it)
 * is inserted again, the first at the head of the queue and the rest just
 * after it in the order they were taken.
 */
export async function restoreQueuedUserMessages(
	sessionId: string,
	sends: readonly QueuedUserSend[],
) {
	if (!sends.length) return;
	const ids = sends.map((send) => inboxId(send.item.id));
	await database().query(
		`with restored as (
		  insert into agent_peer_inbox(id,recipient_id,message,queued_send,created_at)
		  select x.id,$1,x.message,x.stored::jsonb,
		   case when x.n=1 then '-infinity'::timestamptz else timestamptz 'epoch' + (x.n * interval '1 millisecond') end
		  from unnest($2::text[],$3::text[],$4::text[]) with ordinality as x(id,message,stored,n)
		  on conflict(id) do nothing returning recipient_id),
		 lifted as (
		  update agent_peer_inbox set queued_send=queued_send - 'claimedAt'
		  where recipient_id=$1 and id=any($2::text[]) and not accepted and queued_send ? 'claimedAt'
		  returning recipient_id)
		 update agent_session set items=items
		 where id in (select recipient_id from restored union all select recipient_id from lifted)`,
		[
			sessionId,
			ids,
			sends.map((send) => send.message),
			sends.map((send) => {
				const { message: _message, ...stored } = send;
				return jsonbText(stored);
			}),
		],
	);
	console.warn(
		JSON.stringify({
			event: "queued_message.restored",
			sessionId,
			count: sends.length,
		}),
	);
	forgetPeerInboxObservation(sessionId);
	await wakeConversationProgress();
}

/**
 * Holds a send in the chat until the project's environment is ready: the
 * chat's own waiting row, so the chat lists with it, every device shows it,
 * and it goes once the environment is ready even with no tab open. A replay
 * with the same message id adds nothing. Touching `items` republishes the chat.
 * The chat lists the held send's model, the one its turn will use, so the
 * composer shows that model meanwhile (not the catalog's first one).
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
		`with s as (update agent_session set items=items,updated_at=now(),listed_model_id=coalesce(nullif($6,''),listed_model_id) where id=$1 and user_id=$2 returning id),
		 held as (insert into agent_peer_inbox(id,recipient_id,message,queued_send)
		  select $3,s.id,$4,$5::jsonb from s on conflict(id) do nothing returning id)
		 select (select count(*) from s)::int as found`,
		[
			sessionId,
			userId,
			inboxId(send.item.id),
			message,
			jsonbText(held),
			send.modelId,
		],
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
 * Chats holding a send to start: one whose project's environment is now
 * ready, or a waiting message nothing took while its chat sat idle (one
 * workspace's after its build, or any: the periodic sweep).
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
		 where not q.accepted and q.queued_send is not null
		   and (
		    (${heldForSetupSql}
		     and w.status='ready' and (w.provider_ref is not null or w.template_snapshot_id is not null))
		    -- A waiting message nothing took: its turn's end never drained it, or
		    -- its delivery died holding the claim (it lapsed).
		    or (not ${heldForSetupSql} and s.turn_status<>'running'
		     and q.created_at < now() - interval '45 seconds'
		     and coalesce((q.queued_send->>'claimedAt')::bigint,0) < ${nowMsSql} - $3)
		   )
		   and ($1::text is null or w.id::text=$1::text)
		 limit $2`,
		[workspaceId ?? null, limit, QUEUED_CLAIM_TTL_MS],
	);
	return result.rows.map((row) => ({
		userId: row.user_id,
		sessionId: row.id,
		workspaceId: row.workspace_id,
	}));
}
