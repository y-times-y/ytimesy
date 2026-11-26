import { randomUUID } from "node:crypto";
import {
	CAPTAIN_LIMIT,
	CAPTAIN_LINE_LIMIT,
	type Captain,
	type CaptainInput,
	captainWelcome,
} from "#/domain/captain";
import type { SessionTurnStatus } from "#/domain/session-item";
import { database } from "./database";

/**
 * Captains (docs/captains.md, supabase/migrations/20261126130000_captains.sql):
 * rows and one chat each. Nothing here starts a turn, a timer or an object.
 */
type CaptainRow = {
	id: string;
	project_id: string;
	chat_id: string;
	name: string;
	label: string | null;
	color: string;
	role_prompt: string;
	position: number;
	last_line: string | null;
	last_at: Date | string | null;
	created_at: Date | string;
	turn_status?: string | null;
	needs_you?: boolean | null;
};

const iso = (value: Date | string) =>
	value instanceof Date ? value.toISOString() : String(value);

function toCaptain(row: CaptainRow): Captain {
	return {
		id: row.id,
		projectId: row.project_id,
		chatId: row.chat_id,
		name: row.name,
		label: row.label,
		color: row.color,
		rolePrompt: row.role_prompt,
		position: row.position,
		lastLine: row.last_line,
		lastAt: row.last_at ? iso(row.last_at) : null,
		createdAt: iso(row.created_at),
		turnStatus: (row.turn_status ?? "idle") as SessionTurnStatus,
		needsYou: Boolean(row.needs_you),
	};
}

const COLUMNS =
	"c.id,c.project_id,c.chat_id,c.name,c.label,c.color,c.role_prompt,c.position,c.last_line,c.last_at,c.created_at";

/** The project's live captains, in order, with what their chats are doing (no transcript). */
export async function listCaptains(
	userId: string,
	projectId: string,
): Promise<Captain[]> {
	const result = await database().query<CaptainRow>(
		`select ${COLUMNS}, s.turn_status, (s.waiting_on is not null) as needs_you
		 from captain c join agent_session s on s.id=c.chat_id
		 where c.user_id=$1 and c.project_id=$2 and c.archived_at is null
		 order by c.position, c.created_at`,
		[userId, projectId],
	);
	return result.rows.map(toCaptain);
}

const isNameClash = (error: unknown) =>
	(error as { code?: string } | null)?.code === "23505";

export type CaptainResult =
	| { ok: true; captain: Captain }
	| { ok: false; error: string };

/**
 * One statement: the project row is locked, so two creates at once cannot both
 * take the last place. The captain's chat copies the leader's harness, model
 * and workspace row (as Y² does from a thread): it runs on no machine.
 */
export async function createCaptain(
	userId: string,
	projectId: string,
	input: CaptainInput,
): Promise<CaptainResult> {
	const welcome = [
		{
			kind: "agentMessage",
			id: `welcome-${randomUUID()}`,
			text: captainWelcome(input.name, input.rolePrompt),
			phase: "final_answer",
		},
	];
	try {
		const result = await database().query<CaptainRow>(
			`with proj as (
			   select id from project
			   where id=$2 and user_id=$1 and y_enabled and archived_at is null
			     and (leader_name is null or lower(replace(leader_name,' ','-')) <> lower(replace($4,' ','-')))
			   for update
			 ), leader as (
			   select workspace_id, harness, listed_model_id from agent_session
			   where user_id=$1 and project_id=$2 and chat_role='y2' and archived_at is null limit 1
			 ), room as (
			   select count(*) < ${CAPTAIN_LIMIT} as ok, coalesce(max(position),-1)+1 as next
			   from captain where project_id=$2 and archived_at is null
			 ), chat as (
			   insert into agent_session(id,user_id,project_id,workspace_id,harness,title,listed_model_id,status,chat_role,items)
			   select $3,$1,$2,leader.workspace_id,leader.harness,$4,leader.listed_model_id,'starting','captain',$8::jsonb
			   from proj, leader, room where room.ok
			   returning id
			 ), made as (
			   insert into captain(id,user_id,project_id,chat_id,name,label,color,role_prompt,position)
			   select gen_random_uuid(),$1,$2,chat.id,$4,$5,$6,$7,room.next from chat, room
			   returning id,project_id,chat_id,name,label,color,role_prompt,position,last_line,last_at,created_at
			 )
			 select ${COLUMNS.replaceAll("c.", "made.")} from made`,
			[
				userId,
				projectId,
				randomUUID(),
				input.name,
				input.label,
				input.color,
				input.rolePrompt,
				JSON.stringify(welcome),
			],
		);
		if (result.rows[0]) return { ok: true, captain: toCaptain(result.rows[0]) };
	} catch (error) {
		if (isNameClash(error))
			return {
				ok: false,
				error: `A captain named ${input.name} already exists in this project.`,
			};
		throw error;
	}
	return {
		ok: false,
		error: await whyNoCaptain(userId, projectId, input.name),
	};
}

async function whyNoCaptain(userId: string, projectId: string, name: string) {
	const facts = await database().query<{
		found: boolean;
		y_on: boolean;
		leader: boolean;
		live: string;
		leader_named: boolean;
	}>(
		`select p.id is not null as found, coalesce(p.y_enabled,false) as y_on,
		   exists(select 1 from agent_session s where s.user_id=$1 and s.project_id=$2 and s.chat_role='y2' and s.archived_at is null) as leader,
		   (select count(*) from captain c where c.project_id=$2 and c.archived_at is null) as live,
		   coalesce(lower(replace(p.leader_name,' ','-')) = lower(replace($3,' ','-')), false) as leader_named
		 from (select 1) one left join project p on p.id=$2 and p.user_id=$1 and p.archived_at is null`,
		[userId, projectId, name],
	);
	const row = facts.rows[0];
	if (!row?.found) return "That project was not found.";
	if (!row.y_on)
		return "Turn on Y² in this project's settings to add captains.";
	if (!row.leader)
		return "Open this project's Super agent first, then add captains.";
	if (row.leader_named) return `${name} is the leader's name.`;
	if (Number(row.live) >= CAPTAIN_LIMIT)
		return `A project holds up to ${CAPTAIN_LIMIT} captains. Delete one to add another.`;
	return "The captain could not be created.";
}

/** Renames, relabels, recolours or re-roles a captain; its chat's title follows its name. */
export async function updateCaptain(
	userId: string,
	captainId: string,
	input: CaptainInput,
): Promise<CaptainResult> {
	try {
		const result = await database().query<CaptainRow>(
			`with changed as (
			   update captain c set name=$3, label=$4, color=$5, role_prompt=$6
			   where c.id=$2 and c.user_id=$1 and c.archived_at is null
			     and not exists (select 1 from project p where p.id=c.project_id
			       and lower(replace(p.leader_name,' ','-')) = lower(replace($3,' ','-')))
			   returning id,project_id,chat_id,name,label,color,role_prompt,position,last_line,last_at,created_at
			 ), titled as (
			   update agent_session s set title=changed.name from changed where s.id=changed.chat_id returning s.id
			 )
			 select ${COLUMNS.replaceAll("c.", "changed.")} from changed`,
			[
				userId,
				captainId,
				input.name,
				input.label,
				input.color,
				input.rolePrompt,
			],
		);
		if (result.rows[0]) return { ok: true, captain: toCaptain(result.rows[0]) };
	} catch (error) {
		if (isNameClash(error))
			return {
				ok: false,
				error: `A captain named ${input.name} already exists in this project.`,
			};
		throw error;
	}
	return {
		ok: false,
		error: "That captain was not found, or the name is the leader's.",
	};
}

/**
 * Deletes a captain: the row and its chat are archived (nothing is destroyed),
 * which frees the name and the place. Returns the chat to stop and archive
 * through the normal path, or null when it is not the person's live captain.
 */
export async function archiveCaptainRow(
	userId: string,
	captainId: string,
): Promise<{ chatId: string } | null> {
	const result = await database().query<{ chat_id: string }>(
		`with gone as (
		   update captain set archived_at=now()
		   where id=$2 and user_id=$1 and archived_at is null returning chat_id
		 ), chat as (
		   update agent_session s set archived_at=now() from gone where s.id=gone.chat_id returning s.id
		 )
		 select chat_id from gone`,
		[userId, captainId],
	);
	return result.rows[0] ? { chatId: result.rows[0].chat_id } : null;
}

/** What a captain's turn needs: who it is and its role. Null for any other chat. */
export async function captainForChat(
	userId: string,
	chatId: string,
): Promise<{
	id: string;
	projectId: string;
	name: string;
	label: string | null;
	rolePrompt: string;
} | null> {
	const result = await database().query<{
		id: string;
		project_id: string;
		name: string;
		label: string | null;
		role_prompt: string;
	}>(
		`select id,project_id,name,label,role_prompt from captain
		 where chat_id=$2 and user_id=$1 and archived_at is null`,
		[userId, chatId],
	);
	const row = result.rows[0];
	return row
		? {
				id: row.id,
				projectId: row.project_id,
				name: row.name,
				label: row.label,
				rolePrompt: row.role_prompt,
			}
		: null;
}

/** The first line of a captain's last answer, for the sidebar. Bookkeeping: callers swallow its failures. */
export async function recordCaptainLine(chatId: string, text: string) {
	const first =
		text
			.split("\n")
			.map((part) => part.trim())
			.find(Boolean) ?? "";
	if (!first) return;
	await database().query(
		"update captain set last_line=$2, last_at=now() where chat_id=$1 and archived_at is null",
		[chatId, first.slice(0, CAPTAIN_LINE_LIMIT)],
	);
}

/** The leader's display name (Y² shows as "Super agent" while it is null). */
export async function renameLeader(
	userId: string,
	projectId: string,
	name: string | null,
): Promise<boolean> {
	const result = await database().query(
		`update project set leader_name=$3
		 where id=$2 and user_id=$1
		   and not exists (select 1 from captain c where c.project_id=project.id and c.archived_at is null
		     and lower(replace(c.name,' ','-')) = lower(replace(coalesce($3,''),' ','-')))
		 returning id`,
		[userId, projectId, name],
	);
	return (result.rowCount ?? result.rows.length) > 0;
}
