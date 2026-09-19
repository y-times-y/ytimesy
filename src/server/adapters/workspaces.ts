import { randomUUID } from "node:crypto";
import type { ProjectWorkspace } from "../../domain/project-workspace";
import { redactSecrets } from "../../domain/project-workspace";
import { database } from "./database";

interface WorkspaceRow {
	id: string;
	user_id: string;
	project_id: string;
	status: ProjectWorkspace["status"];
	provider_ref: string | null;
	template_snapshot_id: string | null;
	template_source_ref: string | null;
	template_source_sha: string | null;
	error_message: string | null;
	updated_at: Date | string;
}

const WORKSPACE_COLUMNS =
	'id,user_id,project_id,status,provider_ref,template_snapshot_id,template_source_ref,template_source_sha,error_message,updated_at';

export async function workspaceById(workspaceId: string) {
	const result = await database().query(
		`select ${WORKSPACE_COLUMNS} from workspace where id=$1`,
		[workspaceId],
	);
	return result.rows[0] ? toWorkspace(result.rows[0]) : null;
}

export async function workspaceForProject(
	userId: string,
	projectId: string,
): Promise<ProjectWorkspace | null> {
	const result = await database().query(
		`select ${WORKSPACE_COLUMNS} from workspace where user_id=$1 and project_id=$2`,
		[userId, projectId],
	);
	return result.rows[0] ? toWorkspace(result.rows[0]) : null;
}

export async function workspaceForOwner(
	userId: string,
	workspaceId: string,
): Promise<ProjectWorkspace | null> {
	const result = await database().query(
		`select ${WORKSPACE_COLUMNS} from workspace where id=$1 and user_id=$2`,
		[workspaceId, userId],
	);
	return result.rows[0] ? toWorkspace(result.rows[0]) : null;
}

export async function readyWorkspaceForOwner(
	userId: string,
	projectId?: string,
): Promise<ProjectWorkspace | null> {
	if (projectId) {
		const workspace = await workspaceForProject(userId, projectId);
		if (workspace?.status === "ready" && workspace.providerRef)
			return workspace;
		return workspace;
	}
	const result = await database().query(
		`select ${WORKSPACE_COLUMNS}
		 from workspace
		 where user_id=$1 and status='ready' and provider_ref is not null
		 order by updated_at desc
		 limit 1`,
		[userId],
	);
	return result.rows[0] ? toWorkspace(result.rows[0]) : null;
}

export async function insertQueuedWorkspace(
	userId: string,
	projectId: string,
): Promise<ProjectWorkspace> {
	const id = randomUUID();
	const result = await database().query(
		`insert into workspace(id,user_id,project_id,status)
		 values($1,$2,$3,'queued')
		 on conflict(project_id) do update set
		  status=case when workspace.status in ('queued','failed') then 'queued' else workspace.status end,
		  error_message=case when workspace.status='failed' then null else workspace.error_message end,
		  updated_at=case when workspace.status in ('queued','failed') then now() else workspace.updated_at end
		 where workspace.user_id = excluded.user_id
		 returning ${WORKSPACE_COLUMNS}`,
		[id, userId, projectId],
	);
	if (!result.rows[0])
		throw new Response("Workspace is not available.", { status: 403 });
	return toWorkspace(result.rows[0]);
}

export async function markWorkspaceQueued(userId: string, workspaceId: string) {
	const result = await database().query(
		`update workspace set status='queued', error_message=null, updated_at=now()
		 where id=$1 and user_id=$2 and status='failed'
		 returning ${WORKSPACE_COLUMNS}`,
		[workspaceId, userId],
	);
	return result.rows[0] ? toWorkspace(result.rows[0]) : null;
}

export async function claimWorkspaceForJob(workspaceId: string) {
	const result = await database().query(
		`update workspace set status='provisioning', error_message=null, updated_at=now()
		 where id=$1 and status in ('queued','failed')
		 returning ${WORKSPACE_COLUMNS}`,
		[workspaceId],
	);
	return result.rows[0] ? toWorkspace(result.rows[0]) : null;
}

export async function saveProviderRef(
	workspaceId: string,
	providerRef: string,
) {
	const result = await database().query(
		`update workspace set provider_ref=$2, updated_at=now()
		 where id=$1
		 returning ${WORKSPACE_COLUMNS}`,
		[workspaceId, providerRef],
	);
	return toWorkspace(result.rows[0]);
}

export async function saveTemplateSnapshot(
	workspaceId: string,
	snapshotId: string,
) {
	const result = await database().query(
		`update workspace set template_snapshot_id=$2, updated_at=now()
		 where id=$1
		 returning ${WORKSPACE_COLUMNS}`,
		[workspaceId, snapshotId],
	);
	return toWorkspace(result.rows[0]);
}

export async function saveWorkspaceStatus(
	workspaceId: string,
	status: ProjectWorkspace["status"],
	errorMessage: string | null = null,
) {
	const result = await database().query(
		`update workspace set status=$2, error_message=$3, updated_at=now()
		 where id=$1
		 returning ${WORKSPACE_COLUMNS}`,
		[workspaceId, status, errorMessage],
	);
	return toWorkspace(result.rows[0]);
}

export async function saveTemplateSource(
	workspaceId: string,
	sourceRef: string,
	sourceSha: string,
) {
	const result = await database().query(
		`update workspace
		 set template_source_ref=$2, template_source_sha=$3, updated_at=now()
		 where id=$1
		 returning ${WORKSPACE_COLUMNS}`,
		[workspaceId, sourceRef, sourceSha],
	);
	return result.rows[0] ? toWorkspace(result.rows[0]) : null;
}

export async function listReadyWorkspaceIds() {
	const result = await database().query(
		`select id from workspace
		 where status='ready' and template_snapshot_id is not null
		 order by updated_at desc`,
	);
	return result.rows.map((row: { id: string }) => row.id);
}

export async function saveLastJobId(workspaceId: string, jobId: string) {
	await database().query(
		"update workspace set last_job_id=$2, updated_at=now() where id=$1",
		[workspaceId, jobId],
	);
}

export async function recordWorkspaceEvent(
	userId: string,
	workspaceId: string,
	message: string,
) {
	await database().query(
		"insert into workspace_event(id,workspace_id,user_id,message) values($1,$2,$3,$4)",
		[randomUUID(), workspaceId, userId, redactSecrets(message).slice(0, 1000)],
	);
}

export async function listWorkspaceEvents(
	userId: string,
	workspaceId: string,
	limit = 50,
) {
	const result = await database().query(
		"select message,created_at from workspace_event where workspace_id=$1 and user_id=$2 order by created_at desc limit $3",
		[workspaceId, userId, limit],
	);
	return result.rows as { message: string; created_at: Date }[];
}

function toWorkspace(row: WorkspaceRow): ProjectWorkspace {
	return {
		id: row.id,
		userId: row.user_id,
		projectId: row.project_id,
		status: row.status,
		providerRef: row.provider_ref,
		templateSnapshotId: row.template_snapshot_id,
		templateSourceRef: row.template_source_ref,
		templateSourceSha: row.template_source_sha,
		errorMessage: row.error_message,
		updatedAt:
			row.updated_at instanceof Date
				? row.updated_at.toISOString()
				: String(row.updated_at),
	};
}
