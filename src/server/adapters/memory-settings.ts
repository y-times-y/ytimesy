import { randomUUID } from "node:crypto";
import type { ApiTokenUsage } from "#/domain/api-token-usage";
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
export function defaultMemoryMode(): MemoryMode {
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
	/** The project's repository (owner/name); `project:` metadata uses it. */
	project: string | null;
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
		await database().query<{
			id: string;
			title: string;
			project: string | null;
			items: unknown;
			updated_at: Date;
		}>(
			`select s.id,s.title,p.full_name as project,s.items,max(t.updated_at) as updated_at
			 from agent_session s join api_turn t on t.session_id=s.id and t.user_id=s.user_id
			 left join project p on p.id=s.project_id
			 where s.user_id=$1 and s.parent_session_id is null
			   and t.state in ('completed','failed','cancelled')
			   and ($2::timestamptz is null or t.updated_at > $2)
			   and not exists(select 1 from harness_evaluation_run e where e.root_session_id=s.id)
			 group by s.id,p.full_name order by max(t.updated_at) desc limit $3`,
			[userId, since, limit],
		)
	).rows;
	return rows.map((row) => ({
		id: row.id,
		title: row.title,
		project: row.project,
		updatedAt: row.updated_at,
		items: sessionItemsFromUnknown(row.items),
	}));
}

/** One of the user's own chats, for read_source; never another user's. */
export async function memoryChat(
	userId: string,
	sessionId: string,
): Promise<MemoryChat | null> {
	const row = (
		await database().query<{
			id: string;
			title: string;
			project: string | null;
			items: unknown;
			updated_at: Date;
		}>(
			"select s.id,s.title,p.full_name as project,s.items,s.updated_at from agent_session s left join project p on p.id=s.project_id where s.id=$1 and s.user_id=$2",
			[sessionId, userId],
		)
	).rows[0];
	return row
		? {
				id: row.id,
				title: row.title,
				project: row.project,
				updatedAt: row.updated_at,
				items: sessionItemsFromUnknown(row.items),
			}
		: null;
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

/** owner/name of a project, for `project:` metadata. */
export async function memoryProjectName(userId: string, projectId: string) {
	return (
		(
			await database().query<{ full_name: string }>(
				"select full_name from project where id=$1 and user_id=$2",
				[projectId, userId],
			)
		).rows[0]?.full_name ?? null
	);
}
