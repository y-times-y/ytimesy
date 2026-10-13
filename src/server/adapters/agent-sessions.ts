import { randomUUID } from "node:crypto";
import type { AgentProviderId } from "#/domain/agent-provider";
import type {
	AgentTaskAccess,
	AgentTaskExecution,
	AgentTaskPlacement,
	AgentTaskReviewState,
	AgentTaskStatus,
} from "#/domain/agent-task";
import { captureServerAnalytics } from "./analytics";
import { database } from "./database";

const SESSION_COLUMNS =
	"id,user_id,project_id,workspace_id,harness,provider_ref,parent_session_id,candidate_index,title,briefing,items,listed_model_id,turn_status,status,task_prompt,task_state,task_placement,task_access,task_execution,depends_on_session_id,task_summary,task_review_state,task_branch,task_pull_request_url,selected_branch,base_branch,working_branch,created_at,updated_at";

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

export type AgentSessionRecord = {
	id: string;
	userId: string;
	projectId: string;
	workspaceId: string;
	harness: AgentProviderId;
	providerRef: string | null;
	parentSessionId: string | null;
	candidateIndex: number | null;
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
	taskExecution: AgentTaskExecution | null;
	dependsOnSessionId: string | null;
	taskSummary: string | null;
	taskReviewState: AgentTaskReviewState | null;
	taskBranch: string | null;
	selectedBranch?: string | null;
	baseBranch?: string | null;
	workingBranch?: string | null;
	taskPullRequestUrl: string | null;
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
	candidate_index: number | null;
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
	task_execution: AgentTaskExecution | null;
	depends_on_session_id: string | null;
	task_summary: string | null;
	task_review_state: AgentTaskReviewState | null;
	task_branch: string | null;
	selected_branch: string | null;
	base_branch: string | null;
	working_branch: string | null;
	task_pull_request_url: string | null;
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
		 order by updated_at desc`,
		[userId, projectId],
	);
	return result.rows.map((row: AgentSessionRow) => toSession(row));
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

export async function agentSessionForOwner(userId: string, sessionId: string) {
	const result = await database().query(
		`select ${SESSION_COLUMNS} from agent_session where id=$1 and user_id=$2`,
		[sessionId, userId],
	);
	return result.rows[0] ? toSession(result.rows[0]) : null;
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

export async function childAgentSessions(
	userId: string,
	parentSessionId: string,
) {
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
	readonly candidateIndex?: number | null;
	readonly competitionId?: string | null;
	readonly title?: string;
	readonly listedModelId?: string | null;
	readonly task?: {
		readonly prompt: string;
		readonly placement: AgentTaskPlacement;
		readonly access: AgentTaskAccess;
		readonly execution: AgentTaskExecution;
		readonly dependsOnSessionId: string | null;
	};
}) {
	const id = randomUUID();
	const competitionColumn = input.competitionId ? ",competition_id" : "";
	const competitionValue = input.competitionId ? ",$18" : "";
	const result = await database().query(
		`insert into agent_session(
			id,user_id,project_id,workspace_id,harness,provider_ref,
			parent_session_id,candidate_index,title,listed_model_id,status,
			task_prompt,task_state,task_placement,task_access,task_execution,
			depends_on_session_id,task_review_state${competitionColumn}
		)
			 values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'starting',$11,$12,$13,$14,$15,$16,$17${competitionValue})
		 returning ${SESSION_COLUMNS}`,
		[
			id,
			input.userId,
			input.projectId,
			input.workspaceId,
			input.harness,
			input.providerRef ?? null,
			input.parentSessionId ?? null,
			input.candidateIndex ?? null,
			input.title ?? (input.parentSessionId ? "Task" : "New session"),
			input.listedModelId?.trim() || null,
			input.task?.prompt ?? null,
			input.task ? "draft" : null,
			input.task?.placement ?? null,
			input.task?.access ?? (input.parentSessionId ? null : "read_only"),
			input.task?.execution ?? null,
			input.task?.dependsOnSessionId ?? null,
			input.task ? "pending" : null,
			...(input.competitionId ? [input.competitionId] : []),
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

export async function saveAgentTaskDraft(input: {
	readonly userId: string;
	readonly sessionId: string;
	readonly title: string;
	readonly prompt: string;
	readonly harness: AgentProviderId;
	readonly modelId: string;
	readonly placement: AgentTaskPlacement;
	readonly access: AgentTaskAccess;
	readonly execution: AgentTaskExecution;
	readonly dependsOnSessionId: string | null;
}) {
	const result = await database().query(
		`update agent_session set
		 title=$3,task_prompt=$4,harness=$5,listed_model_id=$6,
		 task_placement=$7,task_access=$8,task_execution=$9,
		 depends_on_session_id=$10,updated_at=now()
		 where id=$1 and user_id=$2 and task_state='draft'
		 and parent_session_id is not null and provider_ref is null
		 returning ${SESSION_COLUMNS}`,
		[
			input.sessionId,
			input.userId,
			input.title,
			input.prompt,
			input.harness,
			input.modelId,
			input.placement,
			input.access,
			input.execution,
			input.dependsOnSessionId,
		],
	);
	return result.rows[0] ? toSession(result.rows[0]) : null;
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

export async function saveAgentTaskReview(
	sessionId: string,
	reviewState: AgentTaskReviewState,
) {
	const result = await database().query(
		`update agent_session
		 set task_review_state=$2, updated_at=now()
		 where id=$1 and parent_session_id is not null
		 returning ${SESSION_COLUMNS}`,
		[sessionId, reviewState],
	);
	return result.rows[0] ? toSession(result.rows[0]) : null;
}

export async function saveAgentTaskPublication(
	sessionId: string,
	input: { readonly branch: string; readonly pullRequestUrl: string },
) {
	const result = await database().query(
		`update agent_session
		 set task_branch=$2, task_pull_request_url=$3, updated_at=now()
		 where id=$1 and parent_session_id is not null
		 returning ${SESSION_COLUMNS}`,
		[sessionId, input.branch, input.pullRequestUrl],
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
			JSON.stringify(items),
			title ?? null,
			listedModelId?.trim() || null,
			turnStatus ?? null,
			expectedRunningItems === undefined
				? null
				: JSON.stringify(expectedRunningItems),
		],
	);
	return result.rows[0] ? toSession(result.rows[0]) : null;
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
		candidateIndex: row.candidate_index,
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
		taskExecution: row.task_execution,
		dependsOnSessionId: row.depends_on_session_id,
		taskSummary: row.task_summary,
		taskReviewState: row.task_review_state,
		taskBranch: row.task_branch,
		selectedBranch: row.selected_branch ?? null,
		baseBranch: row.base_branch ?? null,
		workingBranch: row.working_branch ?? null,
		taskPullRequestUrl: row.task_pull_request_url,
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
