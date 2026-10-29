import {
	ARCHIVE_RETENTION_DAYS,
	type ArchivedItem,
	type ArchivedKind,
} from "#/domain/archive";
import { database } from "./database";

/** Archives (or restores) a root chat; false when it is not this user's. */
export async function setChatArchived(
	userId: string,
	sessionId: string,
	archived: boolean,
): Promise<boolean> {
	const result = await database().query(
		`update agent_session set archived_at = case when $3 then now() else null end
		 where id=$2 and user_id=$1 and parent_session_id is null returning id`,
		[userId, sessionId, archived],
	);
	return Boolean(result.rows[0]);
}

/** Archives (or restores) a project; false when it is not this user's. */
export async function setProjectArchived(
	userId: string,
	projectId: string,
	archived: boolean,
): Promise<boolean> {
	const result = await database().query(
		`update project set archived_at = case when $3 then now() else null end
		 where id=$2 and user_id=$1 returning id`,
		[userId, projectId, archived],
	);
	return Boolean(result.rows[0]);
}

/** The project's root chats, for stopping their turns as it is archived. */
export async function projectRootChatIds(userId: string, projectId: string) {
	const result = await database().query<{ id: string }>(
		`select id from agent_session where user_id=$1 and project_id=$2 and parent_session_id is null`,
		[userId, projectId],
	);
	return result.rows.map((row) => row.id);
}

/** Archived projects, and archived chats of projects still in use, newest first. */
export async function listArchived(userId: string): Promise<ArchivedItem[]> {
	const result = await database().query<{
		kind: ArchivedKind;
		id: string;
		project_id: string;
		title: string | null;
		project_name: string | null;
		archived_at: Date;
	}>(
		`select 'project' as kind, p.id, p.id as project_id,
		   coalesce(nullif(p.name,''), p.full_name) as title, null as project_name, p.archived_at
		 from project p where p.user_id=$1 and p.archived_at is not null
		 union all
		 select 'chat', s.id, s.project_id, s.title,
		   coalesce(nullif(p.name,''), p.full_name), s.archived_at
		 from agent_session s join project p on p.id=s.project_id
		 where s.user_id=$1 and s.archived_at is not null and p.archived_at is null
		   and s.parent_session_id is null
		 order by archived_at desc limit 200`,
		[userId],
	);
	return result.rows.map((row) => ({
		kind: row.kind,
		id: row.id,
		projectId: row.project_id,
		title: row.title ?? "Untitled chat",
		projectName: row.project_name,
		archivedAt: row.archived_at.toISOString(),
	}));
}

/** Archived items past the keep, oldest first, for the expiry job. */
export async function expiredArchives(limit = 20) {
	const result = await database().query<{
		kind: ArchivedKind;
		id: string;
		project_id: string;
		user_id: string;
	}>(
		`(select 'project' as kind, id, id as project_id, user_id from project
		  where archived_at < now() - make_interval(days => $1) order by archived_at limit $2)
		 union all
		 (select 'chat', s.id, s.project_id, s.user_id from agent_session s
		  where s.archived_at < now() - make_interval(days => $1) and s.parent_session_id is null
		  order by s.archived_at limit $2)`,
		[ARCHIVE_RETENTION_DAYS, limit],
	);
	return result.rows.map((row) => ({
		kind: row.kind,
		id: row.id,
		projectId: row.project_id,
		userId: row.user_id,
	}));
}
