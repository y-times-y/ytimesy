import { randomUUID } from "node:crypto";
import { claudeRunnerFor } from "#/domain/claude-runner";
import { Y_SQUARED_WELCOME } from "#/domain/y-default";
import { Y_SQUARED_TITLE } from "#/domain/y-squared";
import { database } from "./database";
import { noteProjectsChanged, noteSessionsChanged } from "./list-change-notes";
import { enableNeverChosenProjects } from "./y-backfill";

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
	// The choice is recorded: a backfill never overrides a project the person set.
	const result = await database().query(
		`update project set y_enabled=$3, y_choice=case when $3 then 'on' else 'off' end
		 where id=$1 and user_id=$2 returning id`,
		[projectId, userId, enabled],
	);
	if (!result.rowCount) throw new Error("Project is not available.");
	noteProjectsChanged(userId);
}

/** The user-level switch (default on): false means Y² is off for their projects and new ones. */
export async function readUserYDefault(userId: string): Promise<boolean> {
	const result = await database().query<{ enabled: boolean }>(
		"select enabled from user_y_setting where user_id=$1",
		[userId],
	);
	return result.rows[0]?.enabled ?? true;
}

/** Sets the user-level switch and moves every live project of the user with it, recording the choice. */
export async function setUserYDefault(userId: string, enabled: boolean) {
	await database().query(
		`insert into user_y_setting(user_id,enabled) values($1,$2)
		 on conflict(user_id) do update set enabled=excluded.enabled, updated_at=now()`,
		[userId, enabled],
	);
	await database().query(
		`update project set y_enabled=$2, y_choice=case when $2 then 'on' else 'off' end
		 where user_id=$1 and archived_at is null`,
		[userId, enabled],
	);
	noteProjectsChanged(userId);
}

/**
 * Counts one proactive wake against the user's daily cap across all their
 * projects. False once the cap is reached (the wake is skipped); a failed
 * write lets the wake through, as bookkeeping never blocks the user.
 */
export async function consumeUserWake(
	userId: string,
	cap: number,
): Promise<boolean> {
	try {
		const result = await database().query<{ wakes: number }>(
			`insert into y_wake_day(user_id,day,wakes) values($1,(now() at time zone 'utc')::date,1)
			 on conflict(user_id,day) do update set wakes=y_wake_day.wakes+1
			 returning wakes`,
			[userId],
		);
		return (result.rows[0]?.wakes ?? 1) <= cap;
	} catch (error) {
		console.error("y_squared.user_wake_count_failed", error);
		return true;
	}
}

/**
 * The project's Y² chat, created on first need, never twice: the partial
 * unique index decides a race. It stands beside the project's newest thread
 * (same workspace, harness and model) or, when the project has none yet (it
 * was just added), beside the project's workspace row with the connected
 * `route` (none: the chat is dormant until a model is connected). A new chat
 * starts with the welcome line. Null when the project has no workspace row.
 */
export async function ensureYSquaredChat(
	userId: string,
	projectId: string,
	route?: { readonly harnessId: string; readonly modelId: string } | null,
): Promise<string | null> {
	const welcome = [
		{
			kind: "agentMessage",
			id: `welcome-${randomUUID()}`,
			text: Y_SQUARED_WELCOME,
			phase: "final_answer",
		},
	];
	const result = await database().query<{ id: string }>(
		`with reference as (
		   select workspace_id, harness, listed_model_id from agent_session
		   where user_id=$2 and project_id=$3 and parent_session_id is null
		     and chat_role is null and archived_at is null
		   order by updated_at desc limit 1
		 ), standing_beside as (
		   select * from reference
		   union all
		   select w.id, coalesce($5::text,'api'), $6::text from workspace w
		   where w.project_id=$3 and w.user_id=$2 and not exists(select 1 from reference)
		 ), inserted as (
		   insert into agent_session(id,user_id,project_id,workspace_id,harness,title,listed_model_id,status,chat_role,items)
		   select $1,$2,$3,workspace_id,harness,$4,listed_model_id,'starting','y2',$7::jsonb from standing_beside
		   on conflict (user_id, project_id) where chat_role='y2' and archived_at is null do nothing
		   returning id
		 )
		 select id from inserted
		 union all
		 select id from agent_session
		 where user_id=$2 and project_id=$3 and chat_role='y2' and archived_at is null
		 limit 1`,
		[
			randomUUID(),
			userId,
			projectId,
			Y_SQUARED_TITLE,
			route?.harnessId ?? null,
			route?.modelId ?? null,
			JSON.stringify(welcome),
		],
	);
	// The Super agent row of a new project appears in every open tab.
	if (result.rows[0]) noteSessionsChanged(userId, projectId);
	return result.rows[0]?.id ?? null;
}

/** Turns Y² on for this user's live projects that never chose (see enableNeverChosenProjects). */
export async function enableDefaultYProjects(
	userId: string,
): Promise<string[]> {
	return enableNeverChosenProjects(database(), userId);
}

/**
 * The user's live Y projects that have a workspace but no live Y² chat: the
 * state that draws a project with no Super agent. Ids only.
 */
export async function projectsMissingYSquared(
	userId: string,
): Promise<string[]> {
	const result = await database().query<{ id: string }>(
		`select p.id from project p
		 where p.user_id=$1 and p.archived_at is null and p.y_enabled
		   and exists(select 1 from workspace w where w.project_id=p.id and w.user_id=p.user_id)
		   and not exists(select 1 from agent_session s
		     where s.project_id=p.id and s.user_id=p.user_id and s.chat_role='y2' and s.archived_at is null)
		 limit 50`,
		[userId],
	);
	return result.rows.map((row) => row.id);
}
