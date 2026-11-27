import { database } from "./database";

/**
 * What the database knows about settled threads beyond the sidebar row, read
 * for Y²'s keep-or-archive judgement (src/domain/y-settled-threads.ts) and
 * reuse suggestions. One read per call, only for the ids asked, metadata and
 * counts only: no transcript text leaves the database.
 */
export type ThreadExtra = {
	readonly id: string;
	/** The person's last non-wake message (ms); null: none. */
	readonly lastUserAt: number | null;
	/** A "committed but not pushed" or "not committed" notice stands after the last pull request notice. */
	readonly unpushed: boolean;
	/** A push approval the person has not answered. */
	readonly pendingPush: boolean;
	/** The thread's latest pull request (URL), from its pull request notice. */
	readonly prUrl: string | null;
	/** It ran a tool or builder that may have changed files. */
	readonly mayHaveChanged: boolean;
	readonly itemCount: number;
	/** Its workspace machine exists (not released, has a provider ref). */
	readonly workspaceAlive: boolean;
	readonly modelId: string | null;
	/** Areas the thread touched (project_trace), at most 4. */
	readonly areas: readonly string[];
	readonly updatedAt: number;
};

const NOT_PUSHED = "Changes are committed in this chat but were not pushed%";
const NOT_COMMITTED = "Changes stay in this chat but were not committed%";

export async function threadExtras(
	userId: string,
	projectId: string,
	ids: readonly string[],
): Promise<ThreadExtra[]> {
	if (!ids.length) return [];
	const result = await database().query<{
		id: string;
		last_user_at: Date | null;
		unpushed: boolean;
		pending_push: boolean;
		pr_url: string | null;
		may_have_changed: boolean;
		item_count: number | string;
		workspace_alive: boolean;
		model_id: string | null;
		areas: string[] | null;
		updated_at: Date;
	}>(
		`select s.id::text as id, s.updated_at, s.listed_model_id as model_id,
		   (s.provider_ref is not null and s.machine_released_at is null) as workspace_alive,
		   (select count(*) from agent_session_item i where i.session_id=s.id) as item_count,
		   (select max(i.created_at) from agent_session_item i
		     where i.session_id=s.id and i.kind='userMessage'
		       and coalesce(i.item->>'wake','')<>'true') as last_user_at,
		   exists (select 1 from agent_session_item n
		     where n.session_id=s.id and n.kind='notice'
		       and (n.item->>'message' like $3 or n.item->>'message' like $4)
		       and n.position > coalesce((select max(p.position) from agent_session_item p
		         where p.session_id=s.id and p.kind='notice'
		           and p.item->'pullRequest'->>'state'='opened'),-1)) as unpushed,
		   exists (select 1 from git_push_request r
		     where r.session_id=s.id and r.user_id=$1 and r.used_at is null
		       and r.approved_at is null and r.created_at > now()-interval '48 hours') as pending_push,
		   (select p.item->'pullRequest'->>'url' from agent_session_item p
		     where p.session_id=s.id and p.kind='notice'
		       and p.item->'pullRequest'->>'state'='opened'
		     order by p.position desc limit 1) as pr_url,
		   exists (select 1 from agent_session_item c where c.session_id=s.id
		     and (c.kind in ('fileChange','commandExecution','handoff')
		       or (c.kind='dynamicToolCall' and c.item->>'tool'='agent'
		         and c.item->>'input' ilike '%writer%'))) as may_have_changed,
		   array(select t.area from project_trace t where t.session_id=s.id
		     and t.area is not null group by t.area order by max(t.created_at) desc limit 4) as areas
		 from agent_session s
		 where s.user_id=$1 and s.project_id=$2 and s.id = any($5::uuid[])
		   and s.parent_session_id is null`,
		[userId, projectId, NOT_PUSHED, NOT_COMMITTED, [...ids]],
	);
	return result.rows.map((row) => ({
		id: row.id,
		lastUserAt: row.last_user_at ? row.last_user_at.getTime() : null,
		unpushed: row.unpushed,
		pendingPush: row.pending_push,
		prUrl: row.pr_url,
		mayHaveChanged: row.may_have_changed,
		itemCount: Number(row.item_count),
		workspaceAlive: row.workspace_alive,
		modelId: row.model_id,
		areas: row.areas ?? [],
		updatedAt: row.updated_at.getTime(),
	}));
}

export type SettledDecisionLog = {
	readonly sessionId: string;
	readonly decision: "archived" | "kept" | "refused";
	readonly code: string;
	readonly reason: string;
	/** Facts the decision rested on: numbers and enums, never text. */
	readonly facts: Record<string, unknown>;
};

/**
 * Records decisions (table y_thread_decision). A repeat of the same decision
 * and code for a thread within 24 hours is not written again, so listing the
 * same kept threads at every wake does not grow the table. Bookkeeping: the
 * caller swallows a failure.
 */
export async function logSettledDecisions(
	userId: string,
	projectId: string,
	rows: readonly SettledDecisionLog[],
): Promise<void> {
	for (const row of rows) {
		await database().query(
			`insert into y_thread_decision(user_id, project_id, session_id, decision, code, reason, facts)
			 select $1, $2, $3::uuid, $4, $5, left($6, 300), $7::jsonb
			 where not exists (select 1 from y_thread_decision d
			   where d.session_id=$3::uuid and d.decision=$4 and d.code=$5
			     and d.created_at > now()-interval '24 hours')`,
			[
				userId,
				projectId,
				row.sessionId,
				row.decision,
				row.code,
				row.reason,
				JSON.stringify(row.facts),
			],
		);
	}
}
