import { randomUUID } from "node:crypto";
import type { AgentProviderId } from "#/domain/agent-provider";
import type {
	AgentTaskAccess,
	AgentTaskExecution,
	AgentTaskPlacement,
	AgentTaskReviewState,
	AgentTaskStatus,
} from "#/domain/agent-task";
import { database } from "./database";

const SESSION_COLUMNS =
	"id,user_id,project_id,workspace_id,harness,provider_ref,parent_session_id,candidate_index,title,briefing,items,listed_model_id,turn_status,status,task_prompt,task_state,task_placement,task_access,task_execution,depends_on_session_id,task_summary,task_review_state,task_branch,task_pull_request_url,created_at,updated_at";

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

export async function listUserProviderRefs(
	userId: string,
	excludeProviderRef?: string,
): Promise<string[]> {
	const result = await database().query(
		`select provider_ref
		 from agent_session
		 where user_id=$1 and provider_ref is not null
		 order by updated_at desc`,
		[userId],
	);
	const seen = new Set<string>();
	const refs: string[] = [];
	for (const row of result.rows as { provider_ref: string }[]) {
		const ref = row.provider_ref.trim();
		if (!ref || ref === excludeProviderRef || seen.has(ref)) continue;
		seen.add(ref);
		refs.push(ref);
	}
	return refs;
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

export async function agentSessionForOwner(userId: string, sessionId: string) {
	const result = await database().query(
		`select ${SESSION_COLUMNS} from agent_session where id=$1 and user_id=$2`,
		[sessionId, userId],
	);
	return result.rows[0] ? toSession(result.rows[0]) : null;
}

export async function agentSessionById(sessionId: string) {
	const result = await database().query(
		`select ${SESSION_COLUMNS} from agent_session where id=$1`,
		[sessionId],
	);
	return result.rows[0] ? toSession(result.rows[0]) : null;
}

export async function runningAgentSessions(limit = 20) {
	const result = await database().query(
		`select ${SESSION_COLUMNS} from agent_session
		 where turn_status='running' and provider_ref is not null
		 order by updated_at asc limit $1`,
		[limit],
	);
	return result.rows.map((row: AgentSessionRow) => toSession(row));
}

export async function runningCodexSessions(limit = 100) {
	const result = await database().query<{
		id: string;
		user_id: string;
		provider_ref: string;
		task_placement: AgentTaskPlacement | null;
	}>(
		`select id,user_id,provider_ref,task_placement from agent_session
		 where turn_status='running' and harness='codex' and provider_ref is not null
		 order by updated_at asc limit $1`,
		[limit],
	);
	return result.rows.map((row) => ({
		id: row.id,
		userId: row.user_id,
		providerRef: row.provider_ref,
		taskPlacement: row.task_placement,
	}));
}

export async function childAgentSession(
	userId: string,
	parentSessionId: string,
) {
	const children = await childAgentSessions(userId, parentSessionId);
	return children[0] ?? null;
}

export async function sideAgentSession(
	userId: string,
	parentSessionId: string,
) {
	const result = await database().query(
		`select ${SESSION_COLUMNS}
		 from agent_session
		 where user_id=$1 and parent_session_id=$2 and title='Side chat'
		 order by created_at asc
		 limit 1`,
		[userId, parentSessionId],
	);
	return result.rows[0] ? toSession(result.rows[0]) : null;
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
	return toSession(result.rows[0]);
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

export async function saveAgentTaskSummary(sessionId: string, summary: string) {
	const result = await database().query(
		`update agent_session
		 set task_summary=$2, updated_at=now()
		 where id=$1 and parent_session_id is not null
		 returning ${SESSION_COLUMNS}`,
		[sessionId, summary.trim() || null],
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
		 where id=$1
		 returning ${SESSION_COLUMNS}`,
		[
			sessionId,
			JSON.stringify(items),
			title ?? null,
			listedModelId?.trim() || null,
			turnStatus ?? null,
		],
	);
	return result.rows[0] ? toSession(result.rows[0]) : null;
}

export async function saveAgentSessionTurnStatus(
	sessionId: string,
	turnStatus: AgentSessionRecord["turnStatus"],
) {
	const result = await database().query(
		`update agent_session
		 set turn_status=$2,
		     task_state=case
		       when parent_session_id is null or task_state='draft' then task_state
		       when $2='running' then 'working'
		       when $2='completed' then 'done'
		       when $2='failed' then 'failed'
		       else 'idle'
		     end,
		     updated_at=now()
		 where id=$1
		 returning ${SESSION_COLUMNS}`,
		[sessionId, turnStatus],
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
