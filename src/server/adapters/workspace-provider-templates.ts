import { createHash } from "node:crypto";
import { database } from "./database";

export function authSnapshotFingerprint(snapshotId: string) {
	return createHash("md5").update(snapshotId).digest("hex");
}

type ProviderTemplateRow = {
	workspace_id: string;
	provider: "codex" | "claude";
	auth_snapshot_fingerprint: string;
	project_snapshot_id: string;
	provider_ref: string | null;
	snapshot_id: string | null;
	status: "preparing" | "ready" | "failed";
	claimed_at: string;
};

export type ProviderTemplate = {
	readonly workspaceId: string;
	readonly provider: "codex" | "claude";
	readonly authSnapshotFingerprint: string;
	readonly projectSnapshotId: string;
	readonly providerRef: string | null;
	readonly snapshotId: string | null;
	readonly status: "preparing" | "ready" | "failed";
	readonly claimedAt: string;
};

function toTemplate(row: ProviderTemplateRow): ProviderTemplate {
	return {
		workspaceId: row.workspace_id,
		provider: row.provider,
		authSnapshotFingerprint: row.auth_snapshot_fingerprint,
		projectSnapshotId: row.project_snapshot_id,
		providerRef: row.provider_ref,
		snapshotId: row.snapshot_id,
		status: row.status,
		claimedAt: row.claimed_at,
	};
}

export async function workspaceProviderTemplate(
	workspaceId: string,
	provider: "codex" | "claude",
) {
	const result = await database().query(
		`select workspace_id,provider,auth_snapshot_fingerprint,project_snapshot_id,
		 provider_ref,snapshot_id,status,claimed_at::text as claimed_at
		 from workspace_provider_template where workspace_id=$1 and provider=$2`,
		[workspaceId, provider],
	);
	return result.rows[0] ? toTemplate(result.rows[0]) : null;
}

export async function registerPreparedProviderTemplate(input: {
	readonly workspaceId: string;
	readonly provider: "codex" | "claude";
	readonly authSnapshotId: string;
	readonly projectSnapshotId: string;
}) {
	await database().query(
		`insert into workspace_provider_template(
		 workspace_id,provider,auth_snapshot_fingerprint,project_snapshot_id,
		 snapshot_id,status
		 ) values($1,$2,$3,$4,$4,'ready')
		 on conflict(workspace_id,provider) do update set
		 auth_snapshot_fingerprint=excluded.auth_snapshot_fingerprint,
		 project_snapshot_id=excluded.project_snapshot_id,
		 snapshot_id=excluded.snapshot_id,status='ready',
		 provider_ref=null,error_message=null,updated_at=now()`,
		[
			input.workspaceId,
			input.provider,
			authSnapshotFingerprint(input.authSnapshotId),
			input.projectSnapshotId,
		],
	);
}

export async function claimWorkspaceProviderTemplate(input: {
	readonly workspaceId: string;
	readonly provider: "codex" | "claude";
	readonly authSnapshotId: string;
	readonly projectSnapshotId: string;
}) {
	const result = await database().query(
		`insert into workspace_provider_template(
		 workspace_id,provider,auth_snapshot_fingerprint,project_snapshot_id,status
		 ) values($1,$2,$3,$4,'preparing')
		 on conflict(workspace_id,provider) do update set
		 auth_snapshot_fingerprint=excluded.auth_snapshot_fingerprint,
		 project_snapshot_id=excluded.project_snapshot_id,
		 provider_ref=case
		  when workspace_provider_template.auth_snapshot_fingerprint=excluded.auth_snapshot_fingerprint
		   and workspace_provider_template.project_snapshot_id=excluded.project_snapshot_id
		  then workspace_provider_template.provider_ref else null end,
		 snapshot_id=null,status='preparing',claimed_at=now(),error_message=null,
		 updated_at=now()
		 where workspace_provider_template.auth_snapshot_fingerprint<>excluded.auth_snapshot_fingerprint
		 or workspace_provider_template.project_snapshot_id<>excluded.project_snapshot_id
		 or workspace_provider_template.status='failed'
		 or (workspace_provider_template.status='preparing'
		     and workspace_provider_template.updated_at < now() - interval '45 seconds')
		 returning workspace_id,provider,auth_snapshot_fingerprint,project_snapshot_id,
		 provider_ref,snapshot_id,status,claimed_at::text as claimed_at`,
		[
			input.workspaceId,
			input.provider,
			authSnapshotFingerprint(input.authSnapshotId),
			input.projectSnapshotId,
		],
	);
	return result.rows[0] ? toTemplate(result.rows[0]) : null;
}

export async function renewWorkspaceProviderTemplateClaim(
	workspaceId: string,
	provider: "codex" | "claude",
	claimedAt: string,
) {
	const result = await database().query(
		`update workspace_provider_template set updated_at=now()
		 where workspace_id=$1 and provider=$2 and status='preparing'
		 and claimed_at=$3`,
		[workspaceId, provider, claimedAt],
	);
	return Boolean(result.rowCount);
}

export async function saveWorkspaceProviderTemplateMachine(
	workspaceId: string,
	provider: "codex" | "claude",
	providerRef: string,
	claimedAt: string,
) {
	const result = await database().query(
		`update workspace_provider_template set provider_ref=$3,updated_at=now()
		 where workspace_id=$1 and provider=$2 and status='preparing'
		 and claimed_at=$4`,
		[workspaceId, provider, providerRef, claimedAt],
	);
	if (!result.rowCount) throw new Error("Template preparation claim expired.");
}

export async function completeWorkspaceProviderTemplate(
	workspaceId: string,
	provider: "codex" | "claude",
	snapshotId: string,
	claimedAt: string,
) {
	const result = await database().query(
		`update workspace_provider_template
		 set snapshot_id=$3,status='ready',updated_at=now(),error_message=null
		 where workspace_id=$1 and provider=$2 and status='preparing'
		 and claimed_at=$4`,
		[workspaceId, provider, snapshotId, claimedAt],
	);
	if (!result.rowCount) throw new Error("Template preparation claim expired.");
}

export async function releaseWorkspaceProviderTemplateMachine(
	workspaceId: string,
	provider: "codex" | "claude",
	snapshotId: string,
) {
	await database().query(
		`update workspace_provider_template set provider_ref=null,updated_at=now()
		 where workspace_id=$1 and provider=$2 and status='ready'
		 and snapshot_id=$3`,
		[workspaceId, provider, snapshotId],
	);
}

export async function failWorkspaceProviderTemplate(
	workspaceId: string,
	provider: "codex" | "claude",
	message: string,
	claimedAt: string,
) {
	await database().query(
		`update workspace_provider_template
		 set status='failed',error_message=$3,updated_at=now()
		 where workspace_id=$1 and provider=$2 and status='preparing'
		 and claimed_at=$4`,
		[workspaceId, provider, message.slice(0, 1000), claimedAt],
	);
}
