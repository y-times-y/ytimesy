import { randomUUID } from "node:crypto";
import { claudeRunnerFor } from "#/domain/claude-runner";
import { Y_SQUARED_TITLE } from "#/domain/y-squared";
import { database } from "./database";

/**
 * A project's Y mode (project.y_enabled) and its Y² chat
 * (agent_session.chat_role = 'y2'). Read apart from the session columns, so
 * a database without the column fails only these reads, never every chat.
 */
export type ProjectYMode = {
	readonly enabled: boolean;
	readonly ySquaredId: string | null;
};

/** Null when the project is not this user's. */
export async function projectYMode(
	userId: string,
	projectId: string,
): Promise<ProjectYMode | null> {
	const result = await database().query<{
		y_enabled: boolean;
		y_squared_id: string | null;
	}>(
		`select p.y_enabled,
		  (select s.id from agent_session s
		   where s.user_id=p.user_id and s.project_id=p.id and s.chat_role='y2'
		     and s.archived_at is null limit 1) as y_squared_id
		 from project p where p.id=$1 and p.user_id=$2`,
		[projectId, userId],
	);
	const row = result.rows[0];
	return row ? { enabled: row.y_enabled, ySquaredId: row.y_squared_id } : null;
}

/** Each of the user's Y projects' Y² chat, by project id (one read for a page's sidebar). */
export async function ySquaredChatsByProject(
	userId: string,
): Promise<ReadonlyMap<string, string>> {
	const result = await database().query<{ project_id: string; id: string }>(
		`select s.project_id, s.id from agent_session s
		 join project p on p.id=s.project_id and p.user_id=s.user_id
		 where s.user_id=$1 and s.chat_role='y2' and s.archived_at is null and p.y_enabled`,
		[userId],
	);
	return new Map(result.rows.map((row) => [row.project_id, row.id]));
}

/**
 * Whether this chat is its project's Y² now (Y on, the pinned chat). Y²
 * reads only the database: it gets no machine and no branch. A failed read
 * says no, so the chat is treated as before.
 */
export async function isActiveYSquaredChat(
	userId: string,
	projectId: string,
	session: { readonly id: string; readonly parentSessionId?: string | null },
): Promise<boolean> {
	if (session.parentSessionId) return false;
	const yMode = await projectYMode(userId, projectId).catch(() => null);
	return !!yMode?.enabled && yMode.ySquaredId === session.id;
}

/**
 * Whether this session is its project's live Y² chat. Strict: a failed read
 * throws, so a send that must never reach a Y² turn on the wrong route fails
 * rather than guessing.
 */
export async function isYSquaredSession(
	userId: string,
	sessionId: string,
): Promise<boolean> {
	const result = await database().query(
		`select 1 from agent_session s
		 join project p on p.id=s.project_id and p.user_id=s.user_id
		 where s.id=$1 and s.user_id=$2 and s.chat_role='y2'
		   and s.archived_at is null and p.y_enabled`,
		[sessionId, userId],
	);
	return result.rows.length > 0;
}

/**
 * Whether a Y² chat of this user may run on a Claude subscription: only on a
 * Claude runner box (claude-runner.ts; no machine hosts the CLI for Y²), so
 * this is true exactly when runners are configured. Y² needs no rollout list:
 * it has no repository and no shell, only ytimesy's tools, so the per-user and
 * per-chat lists that guard builders do not apply to it. The one place that
 * decides it: the send gates, the failover plan and the picker's capability flag.
 */
export async function claudeCodeYSquaredAvailable(
	userId: string,
	sessionId?: string,
): Promise<boolean> {
	return (
		claudeRunnerFor({
			env: process.env,
			userId,
			sessionId: sessionId ?? "00000000-0000-4000-8000-000000000000",
			reader: false,
			ySquared: true,
		}) !== null
	);
}

export async function setProjectYMode(
	userId: string,
	projectId: string,
	enabled: boolean,
) {
	const result = await database().query(
		"update project set y_enabled=$3 where id=$1 and user_id=$2 returning id",
		[projectId, userId, enabled],
	);
	if (!result.rowCount) throw new Error("Project is not available.");
}

/**
 * The project's Y² chat, created on first need beside an existing thread
 * (same workspace and harness), never twice: the partial unique index
 * decides a race. Null when the project has no thread to stand beside yet.
 */
export async function ensureYSquaredChat(
	userId: string,
	projectId: string,
): Promise<string | null> {
	const result = await database().query<{ id: string }>(
		`with reference as (
		   select workspace_id, harness, listed_model_id from agent_session
		   where user_id=$2 and project_id=$3 and parent_session_id is null
		     and chat_role is null and archived_at is null
		   order by updated_at desc limit 1
		 ), inserted as (
		   insert into agent_session(id,user_id,project_id,workspace_id,harness,title,listed_model_id,status,chat_role)
		   select $1,$2,$3,workspace_id,harness,$4,listed_model_id,'starting','y2' from reference
		   on conflict (user_id, project_id) where chat_role='y2' and archived_at is null do nothing
		   returning id
		 )
		 select id from inserted
		 union all
		 select id from agent_session
		 where user_id=$2 and project_id=$3 and chat_role='y2' and archived_at is null
		 limit 1`,
		[randomUUID(), userId, projectId, Y_SQUARED_TITLE],
	);
	return result.rows[0]?.id ?? null;
}
