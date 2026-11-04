import { createHash, randomUUID } from "node:crypto";
import type { AgentProviderId } from "#/domain/agent-provider";
import type {
	AgentTaskAccess,
	AgentTaskPlacement,
	AgentTaskReviewState,
	AgentTaskStatus,
} from "#/domain/agent-task";
import {
	ENVIRONMENT_SETUP_TITLE,
	PREVIOUS_SETUP_TITLES,
} from "#/domain/environment-setup";
import { jsonbText } from "#/domain/jsonb";
import { sessionTitleFromText } from "#/domain/session-item";
import type { ChatWaitingOn } from "#/domain/sidebar-chats";
import type {
	SubagentBudget,
	SubagentFork,
	SubagentRole,
} from "#/domain/subagent";
import { captureServerAnalytics } from "./analytics";
import { database } from "./database";
import { heldForSetupSql } from "./queued-user-messages";

const SESSION_COLUMNS =
	"id,user_id,project_id,workspace_id,harness,provider_ref,parent_session_id,title,briefing,items,listed_model_id,turn_status,status,task_prompt,task_state,task_placement,task_access,task_summary,task_review_state,task_branch,selected_branch,base_branch,working_branch,agent_role,agent_budget,agent_fork,agent_steps,created_at,updated_at";

export async function selectAgentSessionHarness(
	userId: string,
	projectId: string,
	sessionId: string,
	harness: AgentProviderId,
): Promise<AgentSessionRecord> {
	const result = await database().query(
		`update agent_session set harness=$4,listed_model_id=null,updated_at=now()
		 where user_id=$1 and project_id=$2 and id=$3 and turn_status <> 'running'
		 returning ${SESSION_COLUMNS}`,
		[userId, projectId, sessionId, harness],
	);
	if (!result.rows[0])
		throw new Error(
			"Finish or stop the current turn before changing providers.",
		);
	return toSession(result.rows[0]);
}

/**
 * The newest root chat in a project that was opened but never used, so
 * "New chat" reopens it instead of leaving empty chats in the sidebar.
 * A send claims its chat by titling it before any slow work (see
 * `claimChatForSend`), so a chat whose first message is still being stored
 * is never handed out again. `claimTitle` claims the reused chat atomically.
 */
export async function reusableEmptyChat(
	userId: string,
	projectId: string,
	harness: AgentProviderId,
	claimTitle?: string,
): Promise<AgentSessionRecord | null> {
	const result = await database().query(
		`update agent_session set harness=$3,title=coalesce($4,title),updated_at=now()
		 where title='New session' and turn_status <> 'running'
			and coalesce(jsonb_array_length(items),0)=0 and id=(
			select s.id from agent_session s
			where s.user_id=$1 and s.project_id=$2 and s.parent_session_id is null
				and s.title='New session' and s.turn_status <> 'running'
				and s.provider_ref is null
				and coalesce(jsonb_array_length(s.items),0)=0
				and not exists (select 1 from api_turn t where t.session_id=s.id)
				-- A chat holding a message (one waiting for setup) is in use.
				and not exists (select 1 from agent_peer_inbox q where q.recipient_id=s.id
					and not q.accepted and q.queued_send is not null)
			order by s.updated_at desc limit 1
		 )
		 returning ${SESSION_COLUMNS}`,
		[userId, projectId, harness, claimTitle ?? null],
	);
	return result.rows[0] ? toSession(result.rows[0]) : null;
}

/**
 * The user's chat in a project that already queued the send with this
 * message id. A new chat's first send has no chat id on the client yet, so a
 * resend after a lost reply finds its chat here instead of opening another.
 */
export async function chatHoldingSend(
	userId: string,
	projectId: string,
	messageId: string,
): Promise<string | null> {
	const result = await database().query(
		`select s.id from agent_session s
		 where s.user_id=$1 and s.project_id=$2 and s.parent_session_id is null
			and exists (select 1 from api_turn t where t.session_id=s.id and t.idempotency_key=$3)
		 order by s.updated_at desc limit 1`,
		[userId, projectId, messageId],
	);
	return result.rows[0]?.id ?? null;
}

/**
 * Marks a chat as taken by a send before the send stores files or commits:
 * an untitled chat takes its first message's title, which also keeps
 * "New chat" from reusing it while that message is still on its way.
 * Resolves whether this send claimed it, so a rejected send can let it go.
 */
export async function claimChatForSend(
	userId: string,
	sessionId: string,
	text: string,
) {
	return titleUntitledAgentSession(
		userId,
		sessionId,
		sessionTitleFromText(text),
	);
}

/**
 * Hands a chat claimed for a rejected send back as untitled when no message
 * was stored, so "New chat" reuses it instead of leaving an empty titled chat.
 */
export async function releaseChatClaim(
	userId: string,
	sessionId: string,
	text: string,
) {
	await database().query(
		`update agent_session s set title='New session', environment_setup=false
		 where s.user_id=$1 and s.id=$2 and (s.title=$3 or (s.environment_setup and s.title=$4))
		 and s.turn_status <> 'running' and coalesce(jsonb_array_length(s.items),0)=0
		 and not exists (select 1 from api_turn t where t.session_id=s.id)
		 and not exists (select 1 from agent_peer_inbox q where q.recipient_id=s.id
		  and not q.accepted and q.queued_send is not null)`,
		[userId, sessionId, sessionTitleFromText(text), ENVIRONMENT_SETUP_TITLE],
	);
}

/** Runs a send on a chat it claimed (by `claimChatForSend` or opening it with a first message). */
export async function releasingChatClaimOnFailure<T>(
	userId: string,
	sessionId: string,
	text: string,
	send: () => Promise<T>,
) {
	try {
		return await send();
	} catch (error) {
		await releaseChatClaim(userId, sessionId, text).catch(() => undefined);
		throw error;
	}
}

/** Names an untitled chat after its first message; a chosen title is kept. */
export async function titleUntitledAgentSession(
	userId: string,
	sessionId: string,
	title: string,
) {
	if (!title || title === "New session") return false;
	const result = await database().query(
		"update agent_session set title=$3 where user_id=$1 and id=$2 and title='New session'",
		[userId, sessionId, title],
	);
	return (result.rowCount ?? 0) > 0;
}

export type AgentSessionRecord = {
	id: string;
	userId: string;
	projectId: string;
	workspaceId: string;
	harness: AgentProviderId;
	providerRef: string | null;
	parentSessionId: string | null;
	title: string;
	briefing: string | null;
	items: unknown;
	listedModelId: string | null;
	turnStatus: "idle" | "running" | "completed" | "failed";
	status: "starting" | "ready" | "failed";
	taskPrompt: string | null;
	taskState: AgentTaskStatus | null;
	taskPlacement: AgentTaskPlacement | null;
	taskAccess: AgentTaskAccess | null;
	taskSummary: string | null;
	/** Retired lead/child review state; read only by benchmarks/evaluation/production.ts. */
	taskReviewState: AgentTaskReviewState | null;
	taskBranch: string | null;
	selectedBranch?: string | null;
	baseBranch?: string | null;
	workingBranch?: string | null;
	/** Set for children started through the builder's agent tool (docs/subagents.md). */
	agentRole?: SubagentRole | null;
	agentBudget?: SubagentBudget | null;
	agentFork?: SubagentFork | null;
	agentSteps?: number;
	createdAt: string;
	updatedAt: string;
};

interface AgentSessionRow {
	id: string;
	user_id: string;
	project_id: string;
	workspace_id: string;
	harness: AgentProviderId;
	provider_ref: string | null;
	parent_session_id: string | null;
	title: string;
	briefing: string | null;
	items: unknown;
	listed_model_id: string | null;
	turn_status: AgentSessionRecord["turnStatus"];
	status: AgentSessionRecord["status"];
	task_prompt: string | null;
	task_state: AgentTaskStatus | null;
	task_placement: AgentTaskPlacement | null;
	task_access: AgentTaskAccess | null;
	task_summary: string | null;
	task_review_state: AgentTaskReviewState | null;
	task_branch: string | null;
	selected_branch: string | null;
	base_branch: string | null;
	working_branch: string | null;
	agent_role?: SubagentRole | null;
	agent_budget?: SubagentBudget | null;
	agent_fork?: SubagentFork | null;
	agent_steps?: number | null;
	created_at: Date | string;
	updated_at: Date | string;
}

export async function listProjectProviderRefs(
	userId: string,
	projectId: string,
): Promise<string[]> {
	const result = await database().query(
		`select provider_ref
		 from agent_session
		 where user_id=$1 and project_id=$2 and provider_ref is not null`,
		[userId, projectId],
	);
	return result.rows.map((row: { provider_ref: string }) => row.provider_ref);
}

export async function listAgentSessions(userId: string, projectId: string) {
	const result = await database().query(
		`select ${SESSION_COLUMNS}
		 from agent_session
		 where user_id=$1 and project_id=$2 and parent_session_id is null
		   and archived_at is null
		 order by updated_at desc`,
		[userId, projectId],
	);
	return result.rows.map((row: AgentSessionRow) => toSession(row));
}

/**
 * The project's chats for the sidebar, without their histories: each with
 * what it waits on from the user and when its oldest active turn (Main's or
 * a helper's) started (null when none is queued or running).
 */
export async function listSidebarAgentSessions(
	userId: string,
	projectId: string,
) {
	// No history: what each chat waits on from the user (chatWaitingOn) is
	// kept on the row (waiting_on, maintained by a trigger on items and
	// turn_status; supabase/migrations/20261026110000_agent_session_waiting_on.sql).
	const result = await database().query(
		`select ${SESSION_COLUMNS.replace(",items,", ",null as items,")},s.waiting_on,
		  -- Opened but never used (as reusableEmptyChat): the sidebar lists it only while open.
		  case when s.title='New session' and s.turn_status <> 'running' then
		    coalesce(jsonb_array_length(s.items),0)=0
		    and not exists (select 1 from api_turn t where t.session_id=s.id)
		    -- A message waiting in it (held for setup) makes it a used chat.
		    and not exists (select 1 from agent_peer_inbox q where q.recipient_id=s.id
		     and not q.accepted and q.queued_send is not null)
		  else false end as unused,
		  exists (select 1 from agent_peer_inbox q where q.recipient_id=s.id
		   and not q.accepted and q.queued_send is not null and ${heldForSetupSql}) as waits_for_setup,
		  (select min(t.created_at) from api_turn t
		   where t.state in ('queued','running')
		    and t.session_id in (select s.id union all
		     select c.id from agent_session c where c.parent_session_id=s.id)) as working_since
		 from agent_session s
		 where s.user_id=$1 and s.project_id=$2 and s.parent_session_id is null
		   and s.archived_at is null
		 order by s.updated_at desc`,
		[userId, projectId],
	);
	return result.rows.map(
		({
			waiting_on,
			unused,
			waits_for_setup,
			...row
		}: AgentSessionRow & {
			working_since: Date | string | null;
			waiting_on: ChatWaitingOn | null;
			unused: boolean | null;
			waits_for_setup?: boolean | null;
		}) => ({
			...withoutItems(toSession(row)),
			waitingOn: waiting_on,
			...(unused ? { unused: true as const } : {}),
			...(waits_for_setup ? { waitsForSetup: true as const } : {}),
			workingSince:
				row.working_since instanceof Date
					? row.working_since.toISOString()
					: row.working_since,
		}),
	);
}

/**
 * Session metadata without its chat history, for callers that already hold the
 * items (the turn executor has the turn's copy); avoids reading the history back.
 */
export async function agentSessionMetadataForOwner(
	userId: string,
	sessionId: string,
): Promise<Omit<AgentSessionRecord, "items"> | null> {
	const result = await database().query(
		`select ${SESSION_COLUMNS.replace(",items,", ",null as items,")} from agent_session where id=$1 and user_id=$2`,
		[sessionId, userId],
	);
	if (!result.rows[0]) return null;
	const { items: _items, ...metadata } = toSession(result.rows[0]);
	return metadata;
}

/**
 * A chat with one page of its transcript (transcriptPageBefore in
 * transcript-page.ts): the `turns` turns before the item `beforeId`, else
 * its last `turns` turns. The database slices the stored array, so only the
 * page leaves it. Null for a chat that is not the user's; `items` is empty
 * and `pageFound` false when the transcript no longer holds `beforeId`.
 */
export async function agentSessionPageForOwner(
	userId: string,
	sessionId: string,
	page: { readonly turns: number; readonly beforeId?: string },
): Promise<
	| (AgentSessionRecord & {
			readonly hasOlderItems: boolean;
			readonly pageFound: boolean;
	  })
	| null
> {
	// Reads agent_session_item (transcript-page-sql.ts): the cursor and the
	// turn starts by index, then only the page's rows.
	const result = await database().query(
		`with s as (select ${SESSION_COLUMNS.replace(",items,", ",")} from agent_session where id=$1 and user_id=$2),
		 st as (select case when $3::text is null
		   then (select coalesce(max(i.position)+1,0) from agent_session_item i where i.session_id=$1)
		   else (select min(i.position) from agent_session_item i where i.session_id=$1 and i.item_id=$3::text) end as stop),
		 b as (select st.stop, (select case when count(*) < $4 then 0 else min(t.position) end
		  from (select i.position from agent_session_item i
		   where i.session_id=$1 and i.starts_turn and i.position < st.stop
		   order by i.position desc limit $4) t) as first from st)
		 select s.*,
		  case when b.stop is null or b.stop <= b.first then '[]'::jsonb
		  else (select jsonb_agg(i.item order by i.position) from agent_session_item i
		   where i.session_id=$1 and i.position >= b.first and i.position < b.stop) end as items,
		  b.first > 0 as has_older_items, b.stop is not null as page_found
		 from s, b`,
		[sessionId, userId, page.beforeId ?? null, page.turns],
	);
	const row = result.rows[0] as
		| (AgentSessionRow & { has_older_items: boolean; page_found: boolean })
		| undefined;
	if (!row) return null;
	return {
		...toSession(row),
		hasOlderItems: row.has_older_items,
		pageFound: row.page_found,
	};
}

export async function agentSessionForOwner(userId: string, sessionId: string) {
	const result = await database().query(
		`select ${SESSION_COLUMNS} from agent_session where id=$1 and user_id=$2`,
		[sessionId, userId],
	);
	return result.rows[0] ? toSession(result.rows[0]) : null;
}

/** The project's latest chat without its history (listAgentSessions()[0], metadata only). */
export async function latestAgentSessionMetadata(
	userId: string,
	projectId: string,
): Promise<Omit<AgentSessionRecord, "items"> | null> {
	const result = await database().query(
		`select ${SESSION_COLUMNS.replace(",items,", ",null as items,")} from agent_session
		 where user_id=$1 and project_id=$2 and parent_session_id is null
		   and archived_at is null
		 order by updated_at desc limit 1`,
		[userId, projectId],
	);
	if (!result.rows[0]) return null;
	const { items: _items, ...metadata } = toSession(result.rows[0]);
	return metadata;
}

/**
 * The chat a page opens in a project, without its history: the linked chat
 * when it is one of the project's top-level chats (as the sidebar lists
 * them), else the latest. Read beside the sidebar list instead of after it.
 */
export async function chatToOpenMetadata(
	userId: string,
	projectId: string,
	linkedChatId?: string,
): Promise<Omit<AgentSessionRecord, "items"> | null> {
	if (linkedChatId) {
		const [linked, archived] = await Promise.all([
			agentSessionMetadataForOwner(userId, linkedChatId),
			database().query(
				"select 1 from agent_session where id=$1 and user_id=$2 and archived_at is not null",
				[linkedChatId, userId],
			),
		]);
		// An archived chat stays out of the app until it is restored.
		if (
			linked?.projectId === projectId &&
			!linked.parentSessionId &&
			!archived.rows[0]
		)
			return linked;
	}
	// Never the project's setup chat: it runs in the background and opens
	// only when picked (chatOpenedWithProject).
	const result = await database().query(
		`select ${SESSION_COLUMNS.replace(",items,", ",null as items,")} from agent_session
		 where user_id=$1 and project_id=$2 and parent_session_id is null
		   and archived_at is null and not environment_setup
		   and not (title = any($3::text[]))
		 order by updated_at desc limit 1`,
		[userId, projectId, [ENVIRONMENT_SETUP_TITLE, ...PREVIOUS_SETUP_TITLES]],
	);
	if (!result.rows[0]) return null;
	const { items: _items, ...metadata } = toSession(result.rows[0]);
	return metadata;
}

/** Selection is a chat draft; it must never invalidate the project template. */
export async function saveSessionBranchSelection(
	userId: string,
	sessionId: string,
	branch: string,
) {
	const result = await database().query(
		`with selected as (
		 update agent_session set selected_branch=$3, updated_at=now()
		 where user_id=$1 and id=$2 and parent_session_id is null and turn_status <> 'running'
		 returning ${SESSION_COLUMNS}
		), retired as (
		 delete from agent_task_command_receipt receipt using selected
		 where receipt.parent_session_id=selected.id
		 and (receipt.request_id like 'verification-baseline:%'
		      or receipt.request_id like 'completion-verification:%')
		)
		 select * from selected`,
		[userId, sessionId, branch],
	);
	if (!result.rows[0])
		throw new Error("Stop the active turn before changing branches.");
	return toSession(result.rows[0]);
}

export async function saveSessionWorkingBranch(
	userId: string,
	sessionId: string,
	branch: string,
	baseBranch?: string,
) {
	const result = await database().query(
		`update agent_session set selected_branch=$3, working_branch=$3, base_branch=coalesce($4,base_branch), updated_at=now()
		 where user_id=$1 and id=$2 and turn_status <> 'running' returning ${SESSION_COLUMNS}`,
		[userId, sessionId, branch, baseBranch ?? null],
	);
	if (!result.rows[0])
		throw new Error("Finish the active turn before submitting another task.");
	return toSession(result.rows[0]);
}

/**
 * Gives a root chat that has no branch of its own (one opened before chats
 * published) its publication branch, during the turn that first pushes. Only
 * a chat still without a working branch takes it, so a name is never
 * replaced; the stored row is returned either way.
 */
export async function adoptChatPublicationBranch(
	userId: string,
	sessionId: string,
	branch: string,
	baseBranch: string,
) {
	const result = await database().query(
		`update agent_session set selected_branch=$3, working_branch=$3, base_branch=coalesce(base_branch,$4), updated_at=now()
		 where user_id=$1 and id=$2 and parent_session_id is null and working_branch is null
		 returning ${SESSION_COLUMNS}`,
		[userId, sessionId, branch, baseBranch],
	);
	if (result.rows[0]) return toSession(result.rows[0]);
	const stored = await agentSessionForOwner(userId, sessionId);
	if (!stored) throw new Error("This chat is no longer available.");
	return stored;
}

/**
 * Records the branch the agent left a root chat's checkout on, so later
 * turns stay there and publish it. The base branch is kept: pull requests
 * still target it. Null when the chat has no branch of its own yet.
 */
export async function saveAgentWorkingBranch(
	userId: string,
	sessionId: string,
	branch: string,
) {
	const result = await database().query(
		`update agent_session set selected_branch=$3, working_branch=$3, updated_at=now()
		 where user_id=$1 and id=$2 and parent_session_id is null and working_branch is not null
		 returning ${SESSION_COLUMNS}`,
		[userId, sessionId, branch],
	);
	return result.rows[0] ? toSession(result.rows[0]) : null;
}

/** Whether another chat or task in the project already works on or published this branch. */
export async function projectBranchHeldByOtherSession(
	userId: string,
	projectId: string,
	sessionId: string,
	branch: string,
) {
	const result = await database().query(
		`select 1 from agent_session where user_id=$1 and project_id=$2 and id<>$3
		 and (working_branch=$4 or task_branch=$4) limit 1`,
		[userId, projectId, sessionId, branch],
	);
	return Boolean(result.rows[0]);
}

export async function agentSessionById(sessionId: string) {
	const result = await database().query(
		`select ${SESSION_COLUMNS} from agent_session where id=$1`,
		[sessionId],
	);
	return result.rows[0] ? toSession(result.rows[0]) : null;
}

export async function childAgentSession(
	userId: string,
	parentSessionId: string,
) {
	const children = await childAgentSessions(userId, parentSessionId);
	return children[0] ?? null;
}

/** The chat's side conversation, the oldest if more than one was opened. */
export async function sideChatForParent(
	userId: string,
	parentSessionId: string,
) {
	const result = await database().query(
		`select ${SESSION_COLUMNS} from agent_session
		 where user_id=$1 and parent_session_id=$2
		 and agent_budget->>'sideChat' = 'true'
		 order by created_at asc limit 1`,
		[userId, parentSessionId],
	);
	return result.rows[0] ? toSession(result.rows[0]) : null;
}

async function childAgentSessions(userId: string, parentSessionId: string) {
	const result = await database().query(
		`select ${SESSION_COLUMNS}
		 from agent_session
		 where user_id=$1 and parent_session_id=$2
		 order by created_at asc`,
		[userId, parentSessionId],
	);
	return result.rows.map((row: AgentSessionRow) => toSession(row));
}

export async function descendantAgentSessions(
	userId: string,
	parentSessionId: string,
) {
	const result = await database().query(
		`with recursive descendants as (
			select ${SESSION_COLUMNS}
			from agent_session
			where user_id=$1 and parent_session_id=$2
			union all
			select ${SESSION_COLUMNS.split(",")
				.map((column) => `child.${column}`)
				.join(",")}
			from agent_session child
			join descendants parent on child.parent_session_id=parent.id
			where child.user_id=$1
		)
		select * from descendants order by created_at asc`,
		[userId, parentSessionId],
	);
	return result.rows.map((row: AgentSessionRow) => toSession(row));
}

/** VMs still bound to one of the owner's sessions outside `sessionIds`. */
export async function providerRefsHeldOutside(
	userId: string,
	sessionIds: readonly string[],
) {
	const result = await database().query<{ provider_ref: string }>(
		`select distinct provider_ref from agent_session
		where user_id=$1 and provider_ref is not null and not (id::text = any($2::text[]))`,
		[userId, sessionIds],
	);
	return new Set(result.rows.map((row) => row.provider_ref));
}

export async function deleteAgentSessionForOwner(
	userId: string,
	sessionId: string,
) {
	await database().query(
		`delete from agent_session where id=$1 and user_id=$2`,
		[sessionId, userId],
	);
}

export async function insertAgentSession(input: {
	readonly userId: string;
	readonly projectId: string;
	readonly workspaceId: string;
	readonly harness: AgentProviderId;
	readonly providerRef?: string | null;
	readonly parentSessionId?: string | null;
	readonly title?: string;
	readonly listedModelId?: string | null;
	readonly task?: {
		readonly prompt: string;
		readonly placement: AgentTaskPlacement;
		readonly access: AgentTaskAccess;
	};
}) {
	const id = randomUUID();
	const result = await database().query(
		`insert into agent_session(
			id,user_id,project_id,workspace_id,harness,provider_ref,
			parent_session_id,title,listed_model_id,status,
			task_prompt,task_state,task_placement,task_access
		)
			 values($1,$2,$3,$4,$5,$6,$7,$8,$9,'starting',$10,$11,$12,$13)
		 returning ${SESSION_COLUMNS}`,
		[
			id,
			input.userId,
			input.projectId,
			input.workspaceId,
			input.harness,
			input.providerRef ?? null,
			input.parentSessionId ?? null,
			input.title ?? (input.parentSessionId ? "Task" : "New session"),
			input.listedModelId?.trim() || null,
			input.task?.prompt ?? null,
			input.task ? "draft" : null,
			input.task?.placement ?? null,
			// Root chats carry no task access: they publish as chats (turnPublicationRole).
			input.task?.access ?? null,
		],
	);
	const session = toSession(result.rows[0]);
	void captureServerAnalytics(
		session.userId,
		"agent_created",
		{
			runtime: session.harness,
			role: !session.parentSessionId
				? "lead"
				: session.taskAccess === "read_write"
					? "builder"
					: "reader",
		},
		{ key: session.id, timestamp: new Date(session.createdAt) },
	);
	return session;
}

/**
 * The one chat a new project's own setup starts in. Its id is derived from
 * the project's, so the primary key makes the start idempotent in the
 * database: two tabs (or a retried request) starting it together insert the
 * same row, and the second gets the first's chat. Null only if that id were
 * somehow another person's or project's row.
 */
export function initialSetupChatId(projectId: string): string {
	const hex = createHash("sha256")
		.update(`ytimesy:initial-setup-chat:${projectId}`)
		.digest("hex");
	const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(
		16,
	);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function claimInitialSetupChat(input: {
	readonly userId: string;
	readonly projectId: string;
	readonly workspaceId: string;
	readonly harness: AgentProviderId;
	readonly title: string;
}): Promise<{ session: AgentSessionRecord; created: boolean } | null> {
	const id = initialSetupChatId(input.projectId);
	const inserted = await database().query(
		`insert into agent_session(id,user_id,project_id,workspace_id,harness,title,status)
		 values($1,$2,$3,$4,$5,$6,'starting')
		 on conflict (id) do nothing
		 returning ${SESSION_COLUMNS}`,
		[
			id,
			input.userId,
			input.projectId,
			input.workspaceId,
			input.harness,
			input.title,
		],
	);
	if (inserted.rows[0]) {
		const session = toSession(inserted.rows[0]);
		void captureServerAnalytics(
			session.userId,
			"agent_created",
			{ runtime: session.harness, role: "lead" },
			{ key: session.id, timestamp: new Date(session.createdAt) },
		);
		return { session, created: true };
	}
	const existing = await database().query(
		`select ${SESSION_COLUMNS} from agent_session where id=$1 and user_id=$2 and project_id=$3`,
		[id, input.userId, input.projectId],
	);
	return existing.rows[0]
		? { session: toSession(existing.rows[0]), created: false }
		: null;
}

export async function saveAgentTaskState(
	sessionId: string,
	taskState: AgentTaskStatus,
) {
	const turnStatus =
		taskState === "working"
			? "running"
			: taskState === "done"
				? "completed"
				: taskState === "failed"
					? "failed"
					: "idle";
	const result = await database().query(
		`update agent_session
		 set task_state=$2, turn_status=$3, updated_at=now()
		 where id=$1 and parent_session_id is not null
		 returning ${SESSION_COLUMNS}`,
		[sessionId, taskState, turnStatus],
	);
	return result.rows[0] ? toSession(result.rows[0]) : null;
}

export async function saveAgentSessionProviderRef(
	sessionId: string,
	providerRef: string,
) {
	const result = await database().query(
		`update agent_session set provider_ref=$2, status='ready', updated_at=now()
		 where id=$1
		 returning ${SESSION_COLUMNS}`,
		[sessionId, providerRef],
	);
	return toSession(result.rows[0]);
}

export async function saveAgentSessionItems(
	sessionId: string,
	items: unknown,
	title?: string,
	listedModelId?: string | null,
	turnStatus?: AgentSessionRecord["turnStatus"],
	expectedRunningItems?: unknown,
) {
	const result = await database().query(
		`update agent_session
		 set items=$2::jsonb,
		     title=coalesce($3, title),
		     listed_model_id=coalesce($4, listed_model_id),
		     turn_status=coalesce($5, turn_status),
		     task_state=case
		       when parent_session_id is null or task_state='draft' or $5 is null then task_state
		       when $5='running' then 'working'
		       when $5='completed' then 'done'
		       when $5='failed' then 'failed'
		       else 'idle'
		     end,
		     updated_at=now()
		 where id=$1 and ($6::jsonb is null or (turn_status='running' and items=$6::jsonb))
		 returning ${SESSION_COLUMNS}`,
		[
			sessionId,
			jsonbText(items),
			title ?? null,
			listedModelId?.trim() || null,
			turnStatus ?? null,
			expectedRunningItems === undefined
				? null
				: jsonbText(expectedRunningItems),
		],
	);
	return result.rows[0] ? toSession(result.rows[0]) : null;
}

function withoutItems(
	session: AgentSessionRecord,
): Omit<AgentSessionRecord, "items"> {
	const { items: _items, ...metadata } = session;
	return metadata;
}

function toSession(row: AgentSessionRow): AgentSessionRecord {
	return {
		id: row.id,
		userId: row.user_id,
		projectId: row.project_id,
		workspaceId: row.workspace_id,
		harness: row.harness,
		providerRef: row.provider_ref,
		parentSessionId: row.parent_session_id,
		title: row.title,
		briefing: row.briefing,
		items: row.items,
		listedModelId: row.listed_model_id,
		turnStatus: row.turn_status ?? "idle",
		status: row.status,
		taskPrompt: row.task_prompt,
		taskState: row.task_state,
		taskPlacement: row.task_placement,
		taskAccess: row.task_access,
		taskSummary: row.task_summary,
		taskReviewState: row.task_review_state,
		taskBranch: row.task_branch,
		selectedBranch: row.selected_branch ?? null,
		baseBranch: row.base_branch ?? null,
		workingBranch: row.working_branch ?? null,
		agentRole: row.agent_role ?? null,
		agentBudget: row.agent_budget ?? null,
		agentFork: row.agent_fork ?? null,
		agentSteps: row.agent_steps ?? 0,
		createdAt:
			row.created_at instanceof Date
				? row.created_at.toISOString()
				: String(row.created_at),
		updatedAt:
			row.updated_at instanceof Date
				? row.updated_at.toISOString()
				: String(row.updated_at),
	};
}
