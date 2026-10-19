import { jsonbText } from "#/domain/jsonb";
import {
	EVIDENCE_KEPT_PER_PULL,
	type EvidenceManifest,
	type EvidenceRecord,
	type EvidenceStatus,
	evidenceManifest,
} from "#/domain/pr-evidence";
import { database } from "./database";

/** Pull request evidence rows (table pr_evidence); media is in pr-evidence-store. */

type Row = {
	id: string;
	project_id: string;
	session_id: string | null;
	full_name: string;
	pull_number: number;
	commit_sha: string;
	head_sha: string | null;
	kind: EvidenceManifest["kind"];
	status: EvidenceStatus;
	reason: string;
	start_command: string;
	urls: unknown;
	files: unknown;
	manifest: unknown;
	browser: string;
	video_seconds: number | null;
	capture_started_at: Date | string | null;
	capture_finished_at: Date | string | null;
	created_at: Date | string;
	expires_at: Date | string;
};

const COLUMNS =
	"id, project_id, session_id, full_name, pull_number, commit_sha, head_sha, kind, status, reason, start_command, urls, files, manifest, browser, video_seconds, capture_started_at, capture_finished_at, created_at, expires_at";

const iso = (value: Date | string | null) =>
	value === null ? null : new Date(value).toISOString();

function stringList(value: unknown) {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function fileList(value: unknown): EvidenceRecord["files"] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((file) =>
		typeof file?.name === "string" &&
		typeof file?.bytes === "number" &&
		typeof file?.sha256 === "string"
			? [{ name: file.name, bytes: file.bytes, sha256: file.sha256 }]
			: [],
	);
}

function toRecord(row: Row): EvidenceRecord {
	const manifest = row.manifest
		? evidenceManifest.safeParse(row.manifest)
		: null;
	return {
		id: row.id,
		projectId: row.project_id,
		sessionId: row.session_id,
		fullName: row.full_name,
		pullNumber: Number(row.pull_number),
		commitSha: row.commit_sha,
		headSha: row.head_sha,
		kind: row.kind,
		status: row.status,
		reason: row.reason,
		startCommand: row.start_command,
		urls: stringList(row.urls),
		files: fileList(row.files),
		manifest: manifest?.success ? manifest.data : null,
		browser: row.browser,
		videoSeconds: row.video_seconds === null ? null : Number(row.video_seconds),
		captureStartedAt: iso(row.capture_started_at),
		captureFinishedAt: iso(row.capture_finished_at),
		createdAt: iso(row.created_at) as string,
		expiresAt: iso(row.expires_at) as string,
	};
}

/** Records a capture as it starts, so the chat can show it running. */
export async function insertCapturingEvidence(input: {
	id: string;
	userId: string;
	projectId: string;
	sessionId: string | null;
	installationId: number | string;
	fullName: string;
	pullNumber: number;
	commitSha: string;
	planKey: string;
	kind: EvidenceManifest["kind"];
}) {
	await database().query(
		`insert into pr_evidence (id, user_id, project_id, session_id, installation_id, full_name, pull_number, commit_sha, plan_key, kind, status)
		values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'capturing')`,
		[
			input.id,
			input.userId,
			input.projectId,
			input.sessionId,
			input.installationId,
			input.fullName,
			input.pullNumber,
			input.commitSha,
			input.planKey,
			input.kind,
		],
	);
}

const timestamp = (value: string) =>
	value && Number.isFinite(Date.parse(value))
		? new Date(value).toISOString()
		: null;

/** Stores the verified result of a capture on its row. */
export async function finishEvidence(
	userId: string,
	id: string,
	input: {
		manifest: EvidenceManifest;
		headSha: string | null;
		files: readonly { name: string; bytes: number; sha256: string }[];
	},
) {
	const { manifest } = input;
	await database().query(
		`update pr_evidence set status=$3, reason=$4, head_sha=$5, start_command=$6, urls=$7::jsonb, files=$8::jsonb, manifest=$9::jsonb, browser=$10, video_seconds=$11, capture_started_at=$12, capture_finished_at=$13, kind=$14, updated_at=now()
		where id=$1 and user_id=$2`,
		[
			id,
			userId,
			manifest.status,
			manifest.reason.slice(0, 600),
			input.headSha,
			manifest.startCommand.slice(0, 500),
			jsonbText(manifest.urls),
			jsonbText(input.files),
			jsonbText(manifest),
			manifest.browser.slice(0, 120),
			input.files.some((file) => file.name === manifest.video?.file)
				? (manifest.video?.seconds ?? null)
				: null,
			timestamp(manifest.startedAt),
			timestamp(manifest.finishedAt),
			manifest.kind,
		],
	);
}

/** One capture, only for the signed-in owner of its project. */
export async function evidenceForOwner(
	userId: string,
	projectId: string,
	evidenceId: string,
) {
	const result = await database().query<Row>(
		`select ${COLUMNS} from pr_evidence e
		where e.id=$1 and e.project_id=$2 and e.user_id=$3
		and exists (select 1 from project p where p.id=e.project_id and p.user_id=$3)`,
		[evidenceId, projectId, userId],
	);
	return result.rows[0] ? toRecord(result.rows[0]) : null;
}

/** A chat's captures, oldest first, for the timeline cards. */
export async function listSessionEvidence(
	userId: string,
	projectId: string,
	sessionId: string,
) {
	const result = await database().query<Row>(
		`select ${COLUMNS} from pr_evidence
		where user_id=$1 and project_id=$2 and session_id=$3
		order by created_at desc limit 20`,
		[userId, projectId, sessionId],
	);
	return result.rows.map(toRecord).reverse();
}

export type EvidenceScope = { id: string; userId: string; projectId: string };

/** A pull request's captures beyond the newest few, to remove after a new capture. */
export async function supersededEvidence(input: {
	userId: string;
	projectId: string;
	fullName: string;
	pullNumber: number;
}) {
	const result = await database().query<{
		id: string;
		user_id: string;
		project_id: string;
	}>(
		`select id, user_id, project_id from pr_evidence
		where user_id=$1 and project_id=$2 and full_name=$3 and pull_number=$4
		order by created_at desc offset $5`,
		[
			input.userId,
			input.projectId,
			input.fullName,
			input.pullNumber,
			EVIDENCE_KEPT_PER_PULL,
		],
	);
	return result.rows.map((row) => ({
		id: row.id,
		userId: row.user_id,
		projectId: row.project_id,
	}));
}

/** Captures past their expiry, oldest first. */
export async function expiredEvidence(now: Date, limit = 500) {
	const result = await database().query<{
		id: string;
		user_id: string;
		project_id: string;
	}>(
		"select id, user_id, project_id from pr_evidence where expires_at<$1 order by expires_at limit $2",
		[now.toISOString(), limit],
	);
	return result.rows.map((row) => ({
		id: row.id,
		userId: row.user_id,
		projectId: row.project_id,
	}));
}

/** Repositories that still hold evidence, for the closed-pull-request check. */
export async function evidenceRepositories(limit = 200) {
	const result = await database().query<{
		installation_id: string | number;
		full_name: string;
	}>(
		"select installation_id, full_name from pr_evidence group by installation_id, full_name order by min(created_at) limit $1",
		[limit],
	);
	return result.rows.map((row) => ({
		installationId: Number(row.installation_id),
		fullName: row.full_name,
	}));
}

/** Captures in one repository whose pull request is not among `open`. */
export async function evidenceOfClosedPulls(
	repository: { installationId: number; fullName: string },
	open: ReadonlySet<number>,
) {
	const result = await database().query<{
		id: string;
		user_id: string;
		project_id: string;
		pull_number: number;
	}>(
		"select id, user_id, project_id, pull_number from pr_evidence where installation_id=$1 and full_name=$2",
		[repository.installationId, repository.fullName],
	);
	return result.rows
		.filter((row) => !open.has(Number(row.pull_number)))
		.map((row) => ({
			id: row.id,
			userId: row.user_id,
			projectId: row.project_id,
		}));
}

/** Rows of a project or account, for deletion. */
export async function evidenceOfOwner(userId: string, projectId?: string) {
	const result = await database().query<{
		id: string;
		user_id: string;
		project_id: string;
	}>(
		projectId
			? "select id, user_id, project_id from pr_evidence where user_id=$1 and project_id=$2"
			: "select id, user_id, project_id from pr_evidence where user_id=$1",
		projectId ? [userId, projectId] : [userId],
	);
	return result.rows.map((row) => ({
		id: row.id,
		userId: row.user_id,
		projectId: row.project_id,
	}));
}

export async function deleteEvidenceRows(ids: readonly string[]) {
	if (!ids.length) return 0;
	const result = await database().query(
		"delete from pr_evidence where id = any($1::uuid[])",
		[ids],
	);
	return result.rowCount ?? 0;
}

/** Captures whose job died mid-run are reported as tooling failures. */
export async function failStaleCaptures(now: Date, minutes = 30) {
	const result = await database().query(
		`update pr_evidence set status='tooling-failed', reason='The capture did not finish.', updated_at=now()
		where status='capturing' and created_at < $1`,
		[new Date(now.getTime() - minutes * 60_000).toISOString()],
	);
	return result.rowCount ?? 0;
}
