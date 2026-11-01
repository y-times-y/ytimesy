import type { ImportStatus, LocalAgent } from "#/domain/local-import";
import { database } from "./database";

/**
 * Rows of "Continue your agent session" (migration
 * 20261101120000_local_session_import.sql). Codes and tokens arrive here
 * already hashed; every read is scoped by the import's user.
 */

export type LocalImportRow = {
	readonly id: string;
	readonly userId: string;
	readonly status: ImportStatus;
	readonly codeExpiresAt: Date;
	readonly codeUsedAt: Date | null;
	readonly tokenExpiresAt: Date | null;
	readonly agent: string | null;
	readonly sessionsPlanned: number;
	readonly sessionsImported: number;
	readonly projectId: string | null;
	readonly sessionId: string | null;
	readonly message: string | null;
};

const COLUMNS = `id, user_id as "userId", status, code_expires_at as "codeExpiresAt",
	code_used_at as "codeUsedAt", token_expires_at as "tokenExpiresAt", agent,
	sessions_planned as "sessionsPlanned", sessions_imported as "sessionsImported",
	project_id as "projectId", session_id as "sessionId", message`;

export async function insertLocalImport(input: {
	readonly id: string;
	readonly userId: string;
	readonly codeHash: string;
	readonly codeExpiresAt: Date;
}) {
	await database().query(
		`insert into local_import(id, user_id, code_hash, code_expires_at)
		 values($1, $2, $3, $4)`,
		[input.id, input.userId, input.codeHash, input.codeExpiresAt],
	);
}

/**
 * Spends a code and issues its token in one statement, so two concurrent
 * starts can never both succeed. Null when the code is unknown, used or expired.
 */
export async function redeemLocalImportCode(input: {
	readonly codeHash: string;
	readonly tokenHash: string;
	readonly tokenExpiresAt: Date;
	readonly agent: string | null;
}): Promise<LocalImportRow | null> {
	const result = await database().query<LocalImportRow>(
		`update local_import
		 set code_used_at = now(), token_hash = $2, token_expires_at = $3,
		     status = 'connected', agent = $4, updated_at = now()
		 where code_hash = $1 and code_used_at is null and status = 'waiting'
		   and code_expires_at > now()
		 returning ${COLUMNS}`,
		[input.codeHash, input.tokenHash, input.tokenExpiresAt, input.agent],
	);
	return result.rows[0] ?? null;
}

export async function localImportByCodeHash(codeHash: string) {
	const result = await database().query<LocalImportRow>(
		`select ${COLUMNS} from local_import where code_hash = $1`,
		[codeHash],
	);
	return result.rows[0] ?? null;
}

export async function localImportByTokenHash(tokenHash: string) {
	const result = await database().query<LocalImportRow>(
		`select ${COLUMNS} from local_import where token_hash = $1`,
		[tokenHash],
	);
	return result.rows[0] ?? null;
}

export async function localImportForOwner(userId: string, id: string) {
	const result = await database().query<LocalImportRow>(
		`select ${COLUMNS} from local_import where id = $1 and user_id = $2`,
		[id, userId],
	);
	return result.rows[0] ?? null;
}

/** Records progress; a finished import (ready/failed) never moves again. */
export async function saveLocalImportProgress(
	id: string,
	update: {
		readonly status?: ImportStatus;
		readonly sessionsPlanned?: number;
		readonly importedOne?: boolean;
		readonly projectId?: string;
		readonly sessionId?: string;
		readonly message?: string | null;
	},
) {
	await database().query(
		`update local_import set
		   status = coalesce($2, status),
		   sessions_planned = greatest(sessions_planned, coalesce($3, 0)),
		   sessions_imported = sessions_imported + case when $4 then 1 else 0 end,
		   project_id = coalesce($5, project_id),
		   session_id = coalesce($6, session_id),
		   message = case when $7::boolean then $8 else message end,
		   updated_at = now()
		 where id = $1 and status not in ('ready', 'failed')`,
		[
			id,
			update.status ?? null,
			update.sessionsPlanned ?? null,
			update.importedOne === true,
			update.projectId ?? null,
			update.sessionId ?? null,
			update.message !== undefined,
			update.message?.slice(0, 300) ?? null,
		],
	);
}

export type ImportedSessionRow = {
	readonly id: string;
	readonly projectId: string;
	readonly tool: LocalAgent;
	readonly sourceSessionId: string;
	readonly title: string;
	readonly turnCount: number;
	readonly sourceUpdatedAt: Date;
	readonly transcriptBytes: number | null;
};

const SESSION_COLUMNS = `id, project_id as "projectId", tool,
	source_session_id as "sourceSessionId", title, turn_count as "turnCount",
	source_updated_at as "sourceUpdatedAt", transcript_bytes as "transcriptBytes"`;

/**
 * Records one imported session under a project the user owns. The same local
 * session imported again keeps its row id (so its stored objects are
 * overwritten in place) and waits for its transcript again.
 */
export async function saveImportedSession(input: {
	readonly id: string;
	readonly importId: string;
	readonly userId: string;
	readonly projectId: string;
	readonly tool: LocalAgent;
	readonly sourceSessionId: string;
	readonly title: string;
	readonly turnCount: number;
	readonly sourceStartedAt: string | null;
	readonly sourceUpdatedAt: string;
	readonly handoffBytes: number;
}): Promise<ImportedSessionRow | null> {
	const result = await database().query<ImportedSessionRow>(
		`insert into local_import_session(
		   id, import_id, user_id, project_id, tool, source_session_id, title,
		   turn_count, source_started_at, source_updated_at, handoff_bytes
		 )
		 select $1, $2, p.user_id, p.id, $5, $6, $7, $8, $9, $10, $11
		 from project p where p.id = $4 and p.user_id = $3
		 on conflict (project_id, tool, source_session_id) do update set
		   import_id = excluded.import_id, title = excluded.title,
		   turn_count = excluded.turn_count,
		   source_started_at = excluded.source_started_at,
		   source_updated_at = excluded.source_updated_at,
		   handoff_bytes = excluded.handoff_bytes, transcript_bytes = null
		 where local_import_session.user_id = excluded.user_id
		 returning ${SESSION_COLUMNS}`,
		[
			input.id,
			input.importId,
			input.userId,
			input.projectId,
			input.tool,
			input.sourceSessionId,
			input.title.slice(0, 300),
			input.turnCount,
			input.sourceStartedAt,
			input.sourceUpdatedAt,
			input.handoffBytes,
		],
	);
	return result.rows[0] ?? null;
}

/** An imported session of this import (the transcript upload names it by id). */
export async function importedSessionOfImport(
	userId: string,
	importId: string,
	id: string,
) {
	const result = await database().query<ImportedSessionRow>(
		`select ${SESSION_COLUMNS} from local_import_session
		 where id = $1 and user_id = $2 and import_id = $3`,
		[id, userId, importId],
	);
	return result.rows[0] ?? null;
}

export async function importedSessionBySource(input: {
	readonly userId: string;
	readonly projectId: string;
	readonly tool: LocalAgent;
	readonly sourceSessionId: string;
}) {
	const result = await database().query<ImportedSessionRow>(
		`select ${SESSION_COLUMNS} from local_import_session
		 where user_id = $1 and project_id = $2 and tool = $3 and source_session_id = $4`,
		[input.userId, input.projectId, input.tool, input.sourceSessionId],
	);
	return result.rows[0] ?? null;
}

export async function saveImportedTranscriptSize(
	userId: string,
	id: string,
	bytes: number,
) {
	await database().query(
		"update local_import_session set transcript_bytes = $3 where id = $1 and user_id = $2",
		[id, userId, bytes],
	);
}

/** A project's imported sessions, newest first: the history its chats can grep. */
export async function projectImportedSessions(
	userId: string,
	projectId: string,
): Promise<ImportedSessionRow[]> {
	const result = await database().query<ImportedSessionRow>(
		`select ${SESSION_COLUMNS} from local_import_session
		 where user_id = $1 and project_id = $2
		 order by source_updated_at desc limit 500`,
		[userId, projectId],
	);
	return result.rows;
}
