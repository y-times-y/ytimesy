import { createHash, randomUUID } from "node:crypto";
import type { ApiTokenUsage } from "#/domain/api-token-usage";
import { jsonbText } from "#/domain/jsonb";
import { type MemoryProject, memoryRecallKey } from "#/domain/memory-layout";
import { type SavedMemoryLine, withSavedMemory } from "#/domain/memory-marker";
import { MEMORY_MODES, type MemoryMode } from "#/domain/memory-repo";
import { chosenRoute, type ModelRoute } from "#/domain/model-failover";
import {
	type SessionItem,
	sessionItemsFromUnknown,
} from "#/domain/session-item";
import { database } from "./database";

export type MemorySettings = {
	mode: MemoryMode;
	repo: string | null;
	dreamedThrough: Date | null;
};

/** Memory is on unless the deployment or the user turns it off. */
function defaultMemoryMode(): MemoryMode {
	const value = process.env.YTIMESY_MEMORY_MODE;
	return MEMORY_MODES.includes(value as MemoryMode)
		? (value as MemoryMode)
		: "full";
}

export async function memorySettings(userId: string): Promise<MemorySettings> {
	const fallback = defaultMemoryMode();
	if (fallback === "off")
		return { mode: "off", repo: null, dreamedThrough: null };
	const row = (
		await database().query<{
			mode: MemoryMode;
			repo: string | null;
			dreamed_through: Date | null;
		}>("select mode,repo,dreamed_through from user_memory where user_id=$1", [
			userId,
		])
	).rows[0];
	return {
		mode: row?.mode ?? fallback,
		repo: row?.repo ?? null,
		dreamedThrough: row?.dreamed_through ?? null,
	};
}

export async function saveMemoryMode(userId: string, mode: MemoryMode) {
	await database().query(
		`insert into user_memory(user_id,mode) values($1,$2)
		 on conflict(user_id) do update set mode=excluded.mode,updated_at=now()`,
		[userId, mode],
	);
}

/** After clearing, the next dream starts from new chats only. */
export async function markMemoryDreamed(userId: string, through: Date) {
	await database().query(
		`insert into user_memory(user_id,mode,dreamed_through) values($1,$3,$2)
		 on conflict(user_id) do update set dreamed_through=greatest(user_memory.dreamed_through,excluded.dreamed_through),updated_at=now()`,
		[userId, through, defaultMemoryMode()],
	);
}

export async function forgetMemoryEmbeddings(userId: string) {
	await database().query("delete from memory_line_embedding where user_id=$1", [
		userId,
	]);
}

/**
 * Users whose chats went idle at least `idleSeconds` ago with activity the
 * last dream did not cover. Benchmark sessions never count.
 */
export async function memoryDreamCandidates(idleSeconds: number, limit = 50) {
	return (
		await database().query<{ user_id: string; last_at: Date }>(
			`with activity as (
			   select s.user_id,max(t.updated_at) as last_at,
			     bool_or(t.state in ('queued','running')) as busy
			   from api_turn t join agent_session s on s.id=t.session_id and s.user_id=t.user_id
			   where s.parent_session_id is null and t.updated_at > now()-interval '7 days'
			     and not exists(select 1 from harness_evaluation_run e where e.root_session_id=s.id)
			   group by s.user_id)
			 select a.user_id,a.last_at from activity a
			 left join user_memory m on m.user_id=a.user_id
			 where not a.busy and a.last_at < now()-make_interval(secs=>$1)
			   and (m.dreamed_through is null or m.dreamed_through < a.last_at)
			   and coalesce(m.mode,$2) <> 'off'
			 order by a.last_at limit $3`,
			[idleSeconds, defaultMemoryMode(), limit],
		)
	).rows;
}

export type MemoryChat = {
	id: string;
	title: string;
	/** The project's repository (owner/name). */
	project: string | null;
	/** The project with its repository ids: which projects/<key>/ folder is its. */
	projectRef?: MemoryProject | null;
	updatedAt: Date;
	items: SessionItem[];
};

/** Root chats with turns after `since`, newest first. */
export async function memoryChatsSince(
	userId: string,
	since: Date | null,
	limit = 10,
): Promise<MemoryChat[]> {
	const rows = (
		await database().query<ChatRow>(
			`select s.id,s.title,p.full_name as project,p.name as project_name,(select coalesce(array_agg(r.repository_id::float8 order by r.position),array[p.repository_id::float8]) from project_repository r where r.project_id=p.id) as project_repository_ids,s.items,max(t.updated_at) as updated_at
			 from agent_session s join api_turn t on t.session_id=s.id and t.user_id=s.user_id
			 left join project p on p.id=s.project_id
			 where s.user_id=$1 and s.parent_session_id is null
			   and t.state in ('completed','failed','cancelled')
			   and ($2::timestamptz is null or t.updated_at > $2)
			   and not exists(select 1 from harness_evaluation_run e where e.root_session_id=s.id)
			 group by s.id,p.id order by max(t.updated_at) desc limit $3`,
			[userId, since, limit],
		)
	).rows;
	return rows.map(chatFromRow);
}

type ChatRow = {
	id: string;
	title: string;
	project: string | null;
	project_name: string | null;
	project_repository_ids: (number | string)[] | null;
	items: unknown;
	updated_at: Date;
};

function chatFromRow(row: ChatRow): MemoryChat {
	return {
		id: row.id,
		title: row.title,
		project: row.project,
		projectRef: row.project
			? {
					fullName: row.project,
					name: row.project_name,
					repositoryIds: (row.project_repository_ids ?? []).map(Number),
				}
			: null,
		updatedAt: row.updated_at,
		items: sessionItemsFromUnknown(row.items),
	};
}

/** One of the user's own chats, for read_source; never another user's. */
export async function memoryChat(
	userId: string,
	sessionId: string,
): Promise<MemoryChat | null> {
	const row = (
		await database().query<ChatRow>(
			`select s.id,s.title,p.full_name as project,p.name as project_name,(select coalesce(array_agg(r.repository_id::float8 order by r.position),array[p.repository_id::float8]) from project_repository r where r.project_id=p.id) as project_repository_ids,s.items,s.updated_at from agent_session s left join project p on p.id=s.project_id where s.id=$1 and s.user_id=$2`,
			[sessionId, userId],
		)
	).rows[0];
	return row ? chatFromRow(row) : null;
}

/** The model route of the user's latest finished root-chat turn: their own model and credentials. */
export async function latestUserModelRoute(
	userId: string,
): Promise<(ModelRoute & { sessionId: string }) | null> {
	const row = (
		await database().query<{
			session_id: string;
			connection_id: string | null;
			connection_revision: string;
			model_id: string;
			settings: unknown;
		}>(
			`select t.session_id,t.connection_id,t.connection_revision,t.model_id,t.settings
			 from api_turn t join agent_session s on s.id=t.session_id and s.user_id=t.user_id
			 where t.user_id=$1 and s.parent_session_id is null and t.state='completed'
			 order by t.updated_at desc limit 1`,
			[userId],
		)
	).rows[0];
	return row ? { ...chosenRoute(row), sessionId: row.session_id } : null;
}

export async function recordMemoryModelUsage(input: {
	userId: string;
	kind: "save" | "dream";
	sessionId: string | null;
	modelId: string;
	usage: ApiTokenUsage | null;
	steps: number;
	outcome: string;
}) {
	await database().query(
		`insert into memory_model_usage(id,user_id,kind,session_id,model_id,input_tokens,output_tokens,cache_read_tokens,steps,outcome)
		 values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
		[
			randomUUID(),
			input.userId,
			input.kind,
			input.sessionId,
			input.modelId,
			input.usage?.inputTokens ?? null,
			input.usage?.outputTokens ?? null,
			input.usage?.cacheReadTokens ?? null,
			input.steps,
			input.outcome.slice(0, 200),
		],
	);
}

export async function memoryEmbeddings(
	userId: string,
	model: string,
	hashes: readonly string[],
) {
	if (!hashes.length) return new Map<string, number[]>();
	const rows = (
		await database().query<{ line_hash: string; embedding: number[] }>(
			"select line_hash,embedding from memory_line_embedding where user_id=$1 and model=$2 and line_hash=any($3::text[])",
			[userId, model, hashes],
		)
	).rows;
	return new Map(rows.map((row) => [row.line_hash, row.embedding.map(Number)]));
}

export async function saveMemoryEmbeddings(
	userId: string,
	model: string,
	rows: readonly { hash: string; embedding: readonly number[] }[],
) {
	if (!rows.length) return;
	await database().query(
		`insert into memory_line_embedding(user_id,model,line_hash,embedding)
		 select $1,$2,h,array(select jsonb_array_elements_text(e)::real)
		 from unnest($3::text[],$4::jsonb[]) as r(h,e)
		 on conflict do nothing`,
		[
			userId,
			model,
			rows.map((row) => row.hash),
			rows.map((row) => JSON.stringify(row.embedding)),
		],
	);
}

type ProjectRow = {
	full_name: string;
	name: string | null;
	repository_ids: (number | string)[] | null;
};
const PROJECT_SELECT = `select p.full_name,p.name,(select coalesce(array_agg(r.repository_id::float8 order by r.position),array[p.repository_id::float8]) from project_repository r where r.project_id=p.id) as repository_ids from project p`;
const projectFromRow = (row: ProjectRow): MemoryProject => ({
	fullName: row.full_name,
	name: row.name,
	repositoryIds: (row.repository_ids ?? []).map(Number),
});

/** A chat's project as memory scopes it: owner/name and its repository ids. */
export async function memoryProject(
	userId: string,
	projectId: string,
): Promise<MemoryProject | null> {
	const row = (
		await database().query<ProjectRow>(
			`${PROJECT_SELECT} where p.id=$1 and p.user_id=$2`,
			[projectId, userId],
		)
	).rows[0];
	return row ? projectFromRow(row) : null;
}

/** Every project of the user (archived too): legacy `project:` names map to their folders. */
export async function memoryProjects(userId: string): Promise<MemoryProject[]> {
	return (
		await database().query<ProjectRow>(
			`${PROJECT_SELECT} where p.user_id=$1 order by p.created_at`,
			[userId],
		)
	).rows.map(projectFromRow);
}

const recallHash = (text: string) =>
	createHash("sha256").update(memoryRecallKey(text)).digest("hex");

/** Notes that memory lines were attached to a request (by text), for dreams to retire unused ones. */
export async function recordMemoryRecalls(
	userId: string,
	texts: readonly string[],
) {
	const hashes = [...new Set(texts.map(recallHash))];
	if (!hashes.length) return;
	await database().query(
		`insert into memory_line_recall(user_id,line_hash)
		 select $1,h from unnest($2::text[]) as h
		 on conflict(user_id,line_hash) do update set recalled_at=now(),recall_count=memory_line_recall.recall_count+1`,
		[userId, hashes],
	);
}

/**
 * When each of these lines was last recalled (YYYY-MM-DD, by
 * memoryRecallKey), and since when the user's recalls are tracked at all.
 */
export async function memoryRecalls(
	userId: string,
	texts: readonly string[],
): Promise<{ recalled: Map<string, string>; since: string | null }> {
	const byHash = new Map(texts.map((text) => [recallHash(text), text]));
	const [rows, first] = await Promise.all([
		byHash.size
			? database().query<{ line_hash: string; day: string }>(
					"select line_hash,to_char(recalled_at at time zone 'UTC','YYYY-MM-DD') as day from memory_line_recall where user_id=$1 and line_hash=any($2::text[])",
					[userId, [...byHash.keys()]],
				)
			: Promise.resolve({ rows: [] as { line_hash: string; day: string }[] }),
		database().query<{ day: string | null }>(
			"select to_char(min(first_recalled_at) at time zone 'UTC','YYYY-MM-DD') as day from memory_line_recall where user_id=$1",
			[userId],
		),
	]);
	const recalled = new Map<string, string>();
	for (const row of rows.rows) {
		const text = byHash.get(row.line_hash);
		if (text !== undefined) recalled.set(memoryRecallKey(text), row.day);
	}
	return { recalled, since: first.rows[0]?.day ?? null };
}

/** Titles of the user's own chats, for "from chat <title>" under recalled memory. */
export async function memoryChatTitles(
	userId: string,
	chatIds: readonly string[],
): Promise<Map<string, string>> {
	if (!chatIds.length) return new Map();
	const rows = (
		await database().query<{ id: string; title: string }>(
			"select id::text,title from agent_session where user_id=$1 and id::text=any($2::text[])",
			[userId, [...new Set(chatIds)]],
		)
	).rows;
	return new Map(rows.map((row) => [row.id, row.title]));
}

/**
 * Adds the save hook's lines to the chat's transcript after its turn. A turn
 * that started meanwhile owns the transcript, so the marker is skipped then
 * (the memory itself is saved either way). Compare-and-set on the items.
 */
export async function recordMemorySaved(
	userId: string,
	sessionId: string,
	userMessageId: string,
	lines: readonly SavedMemoryLine[],
): Promise<boolean> {
	for (let attempt = 0; attempt < 3; attempt++) {
		const row = (
			await database().query<{ items: unknown; turn_status: string | null }>(
				"select items,turn_status from agent_session where id=$1 and user_id=$2",
				[sessionId, userId],
			)
		).rows[0];
		if (!row || row.turn_status === "running" || !Array.isArray(row.items))
			return false;
		// The stored items as they are: rewriting them normalized would change the transcript.
		const items = row.items as SessionItem[];
		const next = withSavedMemory(
			items,
			userMessageId,
			`${userMessageId}:memory-saved`,
			lines,
		);
		if (
			next.length === items.length &&
			next.every((item, i) => item === items[i])
		)
			return true;
		const result = await database().query(
			`update agent_session set items=$3::jsonb,updated_at=now()
			 where id=$1 and user_id=$2 and turn_status is distinct from 'running' and items=$4::jsonb`,
			[sessionId, userId, jsonbText(next), jsonbText(row.items)],
		);
		if (result.rowCount) return true;
	}
	return false;
}

export type RecentChatMessage = {
	sessionId: string;
	title: string;
	text: string;
	at: Date;
};

/**
 * How many of the user's other root chats completed their latest turn in the
 * last `windowSeconds` and have no save-hook run recorded since: saves that
 * are queued or still running. The save hook records its run once it is
 * done (saved, nothing new, or failed), so a new chat can wait for those
 * before it reads memory.
 */
export async function pendingMemorySaves(
	userId: string,
	exceptSessionId: string,
	windowSeconds: number,
): Promise<number> {
	const row = (
		await database().query<{ pending: number | string }>(
			`select count(*) as pending from api_turn t
			 join agent_session s on s.id=t.session_id and s.user_id=$1 and s.parent_session_id is null
			 where t.user_id=$1 and t.session_id::text<>$2 and t.state='completed'
			   and t.updated_at > now()-make_interval(secs=>$3)
			   and not exists(select 1 from api_turn n where n.user_id=$1 and n.session_id=t.session_id and n.updated_at > t.updated_at)
			   and not exists(select 1 from memory_model_usage u where u.user_id=$1 and u.session_id=t.session_id
			     and u.kind='save' and u.created_at >= t.updated_at)`,
			[userId, exceptSessionId, windowSeconds],
		)
	).rows[0];
	return Number(row?.pending ?? 0);
}

/**
 * The latest user message of each of the user's other root chats whose turn
 * is queued or running, or completed in the last `windowSeconds`, and whose
 * save hook has neither shown a saved line (a memorySave after that message)
 * nor found nothing to save: what memory may not hold yet. Newest first.
 * A message counts from when it was sent, not from when its turn's row
 * reads completed, so a chat opened right as another one settles still sees
 * what was said there.
 */
export async function recentUnsavedMessages(
	userId: string,
	exceptSessionId: string,
	windowSeconds: number,
	/** Only chats of this project (null: only chats without one). */
	projectId: string | null,
	limit = 3,
): Promise<RecentChatMessage[]> {
	const rows = (
		await database().query<{
			id: string;
			title: string | null;
			text: string | null;
			at: Date;
		}>(
			`with recent as (select session_id,max(case when state='completed' then updated_at else now() end) as at
			   from api_turn where user_id=$1 and session_id::text<>$2
			     and (state in ('queued','running') or (state='completed' and updated_at > now()-make_interval(secs=>$3)))
			   group by session_id)
			 select s.id::text as id,s.title,m.e->>'text' as text,r.at
			 from recent r join agent_session s on s.id=r.session_id and s.user_id=$1 and s.parent_session_id is null
			   and s.project_id is not distinct from $5::uuid
			 join lateral (select x.e,x.i from jsonb_array_elements(s.items) with ordinality as x(e,i)
			   where x.e->>'kind'='userMessage' order by x.i desc limit 1) m on true
			 where not exists(select 1 from jsonb_array_elements(s.items) with ordinality as y(e,j)
			     where y.j > m.i and y.e->>'kind'='memorySave')
			   and not exists(select 1 from memory_model_usage u
			     where u.user_id=s.user_id and u.session_id=s.id and u.kind='save'
			       and u.created_at >= r.at and u.outcome like '%:nothing-new')
			 order by r.at desc limit $4`,
			[userId, exceptSessionId, windowSeconds, limit, projectId],
		)
	).rows;
	return rows.flatMap((row) =>
		row.text?.trim()
			? [
					{
						sessionId: row.id,
						title: row.title ?? "",
						text: row.text,
						at: new Date(row.at),
					},
				]
			: [],
	);
}

/** When a dream last also reviewed the whole repo (outcome suffix ":review"). */
export async function lastMemoryReview(userId: string): Promise<Date | null> {
	const row = (
		await database().query<{ at: Date | null }>(
			"select max(created_at) as at from memory_model_usage where user_id=$1 and kind='dream' and outcome like '%:review'",
			[userId],
		)
	).rows[0];
	return row?.at ? new Date(row.at) : null;
}

/** When a dream last ran for the user, whatever its outcome, or null. */
export async function lastMemoryDreamRun(userId: string): Promise<Date | null> {
	const row = (
		await database().query<{ at: Date | null }>(
			"select max(created_at) as at from memory_model_usage where user_id=$1 and kind='dream'",
			[userId],
		)
	).rows[0];
	return row?.at ? new Date(row.at) : null;
}

/**
 * The user's latest chat activity a dream would read (root chats, last 7
 * days, no benchmark sessions), as memoryDreamCandidates counts it.
 */
export async function memoryLastActivity(userId: string): Promise<Date | null> {
	const row = (
		await database().query<{ at: Date | null }>(
			`select max(t.updated_at) as at
			 from api_turn t join agent_session s on s.id=t.session_id and s.user_id=t.user_id
			 where t.user_id=$1 and s.parent_session_id is null and t.updated_at > now()-interval '7 days'
			   and not exists(select 1 from harness_evaluation_run e where e.root_session_id=s.id)`,
			[userId],
		)
	).rows[0];
	return row?.at ? new Date(row.at) : null;
}
