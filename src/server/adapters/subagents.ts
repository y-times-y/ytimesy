import { USER_MESSAGE_BULK_KEYS } from "#/domain/session-item-projection";
import type { SidekickState } from "#/domain/sidekick";
import type {
	HelperForkFacts,
	SubagentBudget,
	SubagentFork,
	SubagentRole,
} from "#/domain/subagent";
import {
	type AgentSessionRecord,
	agentSessionAncestorMetadata,
	agentSessionItemsOfKindsForOwner,
	agentSessionMetadataForOwner,
	descendantAgentSessionMetadata,
} from "./agent-sessions";
import { database } from "./database";

/** Records the role and budget of a child the agent tool just created. */
export async function saveSubagentSpec(
	userId: string,
	sessionId: string,
	spec: { readonly role: SubagentRole; readonly budget: SubagentBudget },
) {
	const result = await database().query(
		`update agent_session set agent_role=$3, agent_budget=$4::jsonb, updated_at=now()
		 where user_id=$1 and id=$2 and parent_session_id is not null`,
		[userId, sessionId, spec.role, JSON.stringify(spec.budget)],
	);
	if (!result.rowCount) throw new Error("The new agent's session is missing.");
}

/**
 * Counts one model step against a subagent's budget; returns the new total
 * and the budget as stored now (agent_send stop changes it mid-turn).
 */
export async function recordSubagentStep(sessionId: string) {
	const result = await database().query(
		`update agent_session set agent_steps=agent_steps+1
		 where id=$1 and agent_role is not null returning agent_steps, agent_budget`,
		[sessionId],
	);
	const row = result.rows[0] as
		| { agent_steps: number; agent_budget: SubagentBudget | null }
		| undefined;
	return {
		steps: Number(row?.agent_steps ?? 0),
		budget: row?.agent_budget ?? null,
	};
}

/** Merges fields into a writer's fork record. */
export async function mergeSubagentFork(
	sessionId: string,
	fields: Partial<SubagentFork>,
) {
	await database().query(
		`update agent_session set agent_fork=coalesce(agent_fork,'{}'::jsonb) || $2::jsonb, updated_at=now()
		 where id=$1`,
		[sessionId, JSON.stringify(fields)],
	);
}

/**
 * The session's ancestors, nearest first (the root last), at most 8; without
 * their transcripts (callers read their ids, models and the chain's length).
 */
export async function subagentAncestors(
	userId: string,
	sessionId: string,
): Promise<Omit<AgentSessionRecord, "items">[]> {
	return agentSessionAncestorMetadata(userId, sessionId, 8);
}

/**
 * The transcript item kinds the subagent tree reads (subagentTree in
 * src/domain/subagent-tree.ts): usage and turn ends live on user messages,
 * a wake-up turn's start on a notice.
 */
export const SUBAGENT_TREE_ITEM_KINDS = ["userMessage", "notice"] as const;

/**
 * The whole tree under a root: the root first, then every descendant. Each
 * session's `items` holds only its SUBAGENT_TREE_ITEM_KINDS items, in order
 * (what the tree's spend and clocks read), not its whole transcript.
 */
export async function subagentTree(
	userId: string,
	rootSessionId: string,
): Promise<AgentSessionRecord[]> {
	const [root, descendants] = await Promise.all([
		agentSessionMetadataForOwner(userId, rootSessionId),
		descendantAgentSessionMetadata(userId, rootSessionId),
	]);
	if (!root) return [];
	const sessions = [root, ...descendants];
	const items = await agentSessionItemsOfKindsForOwner(
		userId,
		sessions.map((session) => session.id),
		SUBAGENT_TREE_ITEM_KINDS,
		// The tree reads each message's text, timing and token use, never its files or recalled memory.
		{ omit: USER_MESSAGE_BULK_KEYS },
	);
	return sessions.map((session) => ({
		...session,
		items: items.get(session.id) ?? [],
	}));
}

/**
 * Saves a sidekick's state (src/domain/sidekick.ts) into its budget.
 * `clearStop` drops an earlier agent_send stop's step limit (a new round).
 */
export async function saveSidekickState(
	sessionId: string,
	state: SidekickState,
	options: { readonly clearStop?: boolean } = {},
) {
	await database().query(
		`update agent_session set agent_budget=(coalesce(agent_budget,'{}'::jsonb)${options.clearStop ? " - 'stopAtStep'" : ""}) || jsonb_build_object('sidekick', $2::jsonb), updated_at=now()
		 where id=$1 and agent_role='writer'`,
		[sessionId, JSON.stringify(state)],
	);
}

/**
 * Applies `mutate` to the sidekick's current state and saves it only if
 * nothing changed it meanwhile (compare-and-set on the stored state,
 * retried), so a slow caller (the classifier) never overwrites a newer
 * write. A retired sidekick stays retired. With `model` the session's model
 * changes in the same statement (a switch at compaction). Returns the saved
 * state, or null when there is no sidekick or `mutate` declines.
 */
export async function updateSidekickState(
	sessionId: string,
	mutate: (current: SidekickState) => SidekickState | null,
	model?: { readonly listedModelId: string; readonly harness: "codex" | "api" },
): Promise<SidekickState | null> {
	for (let attempt = 0; attempt < 5; attempt++) {
		const read = await database().query<{ sidekick: SidekickState | null }>(
			`select agent_budget->'sidekick' as sidekick from agent_session
			 where id=$1 and agent_role='writer'`,
			[sessionId],
		);
		const current = read.rows[0]?.sidekick;
		if (!current) return null;
		const mutated = mutate(current);
		if (!mutated) return null;
		const next =
			current.retired && !mutated.retired
				? { ...mutated, retired: current.retired }
				: mutated;
		const saved = await database().query(
			`update agent_session
			 set agent_budget=jsonb_set(agent_budget, '{sidekick}', $2::jsonb),
			     listed_model_id=coalesce($4, listed_model_id),
			     harness=coalesce($5, harness),
			     updated_at=now()
			 where id=$1 and agent_role='writer' and agent_budget->'sidekick' = $3::jsonb`,
			[
				sessionId,
				JSON.stringify(next),
				JSON.stringify(current),
				model?.listedModelId ?? null,
				model?.harness ?? null,
			],
		);
		if (saved.rowCount) return next;
	}
	throw new Error("The sidekick's state kept changing; it was not saved.");
}

/**
 * Adds a one-off model call's usage (the sidekick classifier's) to the
 * session's latest request, where its turns' usage lives, so session and
 * eval totals include it. Compare-and-set on the items, retried.
 */
export async function addSessionRequestUsage(
	sessionId: string,
	add: (items: unknown[]) => unknown[] | null,
) {
	for (let attempt = 0; attempt < 5; attempt++) {
		const read = await database().query<{ items: unknown[] | null }>(
			"select items from agent_session where id=$1",
			[sessionId],
		);
		const items = read.rows[0]?.items;
		if (!Array.isArray(items)) return false;
		const next = add(items);
		if (!next) return false;
		// A running turn's history copy (the chat Durable Object's, keyed by
		// api_turn.updated_at) is invalidated in the same statement. The turn row
		// is locked first (the subquery runs before the chat's update), in the
		// order the turn's own writes lock them.
		const saved = await database().query(
			`with turns as (update api_turn set updated_at=now() where session_id=$1 and state='running'
			 and exists(select 1 from agent_session where id=$1 and items = $3::jsonb) returning id)
			 update agent_session set items=$2::jsonb, updated_at=now()
			 where id=$1 and items = $3::jsonb and (select count(*) from turns)>=0`,
			[sessionId, JSON.stringify(next), JSON.stringify(items)],
		);
		if (saved.rowCount) return true;
	}
	return false;
}

/** A writer's fork row as the teardown sweep reads it. */
type HelperForkRow = {
	id: string;
	user_id: string;
	vm_id: string;
	agent_role: SubagentRole | null;
	task_placement: string | null;
	agent_fork: SubagentFork;
	turn_status: string;
	parent_vm_id: string | null;
	active_turn: boolean;
	pending_message: boolean;
	report_undelivered: boolean;
	open_background_command: boolean;
	held_elsewhere: boolean;
	active_sidekick: boolean;
};

/**
 * Writer forks the teardown sweep may delete, with what decides it
 * (helperForkReleaseBlocker): reported at least `graceMinutes` ago, or a
 * release already claimed and not finished. Any age, so a fork an earlier
 * sweep missed is still found. Forks that can never go by themselves (their
 * patch was not captured, an active sidekick, a shared writer) are left out
 * here so they never crowd out the rest.
 */
export async function helperForksDueForRelease(
	graceMinutes: number,
	limit = 32,
): Promise<
	(HelperForkFacts & { readonly sessionId: string; readonly userId: string })[]
> {
	const result = await database().query<HelperForkRow>(
		`select s.id::text id, s.user_id, s.agent_fork->>'vmId' vm_id, s.agent_role,
		   s.task_placement, s.agent_fork, s.turn_status, parent.provider_ref parent_vm_id,
		   exists (select 1 from api_turn t where t.session_id=s.id and t.state in ('queued','running')) active_turn,
		   exists (select 1 from agent_peer_inbox m where m.recipient_id=s.id and not m.accepted) pending_message,
		   exists (select 1 from agent_task_event e where e.child_session_id=s.id and e.status<>'delivered') report_undelivered,
		   exists (select 1 from agent_session_item i where i.session_id=s.id
		     and i.kind='dynamicToolCall' and i.item->'background' is not null
		     and (i.item #> '{background,exitCode}') is null) open_background_command,
		   (exists (select 1 from agent_session o where o.provider_ref=s.agent_fork->>'vmId' and o.id<>s.id)
		     or exists (select 1 from workspace w where w.provider_ref=s.agent_fork->>'vmId')) held_elsewhere,
		   (s.agent_budget ? 'sidekick' and not (s.agent_budget->'sidekick' ? 'retired')) active_sidekick
		 from agent_session s
		 left join agent_session parent on parent.id=s.parent_session_id
		 where s.agent_role='writer' and s.parent_session_id is not null
		   and s.task_placement is distinct from 'shared'
		   and s.agent_fork ? 'vmId'
		   and not (s.agent_fork ? 'deletedAt')
		   and (s.agent_fork ? 'releasingAt' or (
		     s.agent_fork ? 'reportedAt'
		     and (s.agent_fork->>'reportedAt')::timestamptz < now() - make_interval(mins => $1)
		     and coalesce(s.agent_fork->>'patchError','')=''
		     and not (s.agent_budget ? 'sidekick' and not (s.agent_budget->'sidekick' ? 'retired'))
		   ))
		 order by s.agent_fork ? 'releasingAt' desc, (s.agent_fork->>'reportedAt') asc
		 limit $2`,
		[graceMinutes, limit],
	);
	return result.rows.map((row) => ({
		sessionId: row.id,
		userId: row.user_id,
		vmId: row.vm_id,
		role: row.agent_role,
		taskPlacement: row.task_placement,
		fork: row.agent_fork,
		turnStatus: row.turn_status,
		parentVmId: row.parent_vm_id,
		activeTurn: row.active_turn,
		pendingMessage: row.pending_message,
		reportUndelivered: row.report_undelivered,
		openBackgroundCommand: row.open_background_command,
		heldElsewhere: row.held_elsewhere,
		activeSidekick: row.active_sidekick,
	}));
}

/**
 * Claims a fork for deletion: the session stops naming it (a turn that
 * starts from now on gets a fresh fork) and `releasingAt` marks the claim,
 * so a failed delete is retried. Re-checked in the same statement: no turn
 * running or queued and no message waiting. False when that no longer holds.
 */
export async function claimHelperForkRelease(sessionId: string, vmId: string) {
	const result = await database().query(
		`update agent_session s
		 set provider_ref = case when s.provider_ref=$2 then null else s.provider_ref end,
		     agent_fork = s.agent_fork || jsonb_build_object('releasingAt',
		       coalesce(s.agent_fork->>'releasingAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
		 where s.id=$1 and s.agent_fork->>'vmId'=$2 and not (s.agent_fork ? 'deletedAt')
		   and s.turn_status <> 'running'
		   and not exists (select 1 from api_turn t where t.session_id=s.id and t.state in ('queued','running'))
		   and not exists (select 1 from agent_peer_inbox m where m.recipient_id=s.id and not m.accepted)
		 returning s.id`,
		[sessionId, vmId],
	);
	return (result.rowCount ?? 0) > 0;
}

/** Records that the claimed fork's VM is deleted; a no-op once recorded or re-forked. */
export async function markHelperForkReleased(sessionId: string, vmId: string) {
	await database().query(
		`update agent_session
		 set agent_fork = agent_fork || jsonb_build_object('deletedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
		     provider_ref = case when provider_ref=$2 then null else provider_ref end
		 where id=$1 and agent_fork->>'vmId'=$2 and not (agent_fork ? 'deletedAt')`,
		[sessionId, vmId],
	);
}

/**
 * Writers whose fork was deleted before releases cleared the session's
 * provider ref still name the deleted VM (resuming them failed on it):
 * they stop naming it. Returns how many changed.
 */
export async function forgetDeletedHelperForks() {
	const result = await database().query(
		`update agent_session set provider_ref=null
		 where agent_role='writer' and parent_session_id is not null
		   and agent_fork ? 'deletedAt' and provider_ref=agent_fork->>'vmId'`,
	);
	return result.rowCount ?? 0;
}

/**
 * A released writer resumed on a fresh fork: its fork record is replaced
 * (the earlier report's patch stays in `previousPatch` for reference).
 */
export async function replaceHelperFork(sessionId: string, fork: SubagentFork) {
	await database().query(
		`update agent_session
		 set agent_fork = $2::jsonb || case when agent_fork->'patch' is not null and jsonb_typeof(agent_fork->'patch')='object'
		       then jsonb_build_object('previousPatch', agent_fork->'patch') else '{}'::jsonb end,
		     provider_ref = $3, updated_at = now()
		 where id=$1`,
		[sessionId, JSON.stringify(fork), fork.vmId],
	);
}

/**
 * Active sidekicks idle (not working, their lead not working) for at least
 * `idleMinutes` since their last report: the maintenance sweep retires
 * them (they hold no VM of their own).
 */
export async function idleSidekicksPastTtl(idleMinutes: number) {
	const result = await database().query(
		`select id, agent_role, agent_budget, agent_fork, turn_status
		 from agent_session
		 where agent_role='writer'
		   and agent_budget ? 'sidekick'
		   and not (agent_budget->'sidekick' ? 'retired')
		   and turn_status <> 'running'
		   and coalesce((agent_fork->>'reportedAt')::timestamptz, updated_at) < now() - ($1::float8 * interval '1 minute')
		   and not exists (
		     select 1 from agent_session lead_session
		     where lead_session.id = agent_session.parent_session_id and lead_session.turn_status = 'running'
		   )
		 limit 32`,
		[idleMinutes],
	);
	return result.rows.map(
		(row: {
			id: string;
			agent_role: SubagentRole;
			agent_budget: SubagentBudget;
			agent_fork: SubagentFork | null;
			turn_status: AgentSessionRecord["turnStatus"];
		}) => ({
			id: row.id,
			agentRole: row.agent_role,
			agentBudget: row.agent_budget,
			agentFork: row.agent_fork,
			turnStatus: row.turn_status,
		}),
	);
}

/**
 * Takes a child's undelivered terminal report for a parent that waited on
 * it (agent with wait: true), so the same report is not delivered again as
 * a message. Null when there is none yet or delivery already claimed it.
 */
export async function takeSubagentReport(childSessionId: string) {
	// Also a report the delivery worker is staging ('delivering'): the waiter
	// wins, and the staged copy is retracted from the parent's mailbox.
	const result = await database().query(
		`update agent_task_event set status='delivered', delivered_at=now(), last_error=null
		 where child_session_id=$1 and status in ('pending','delivering') and event_type in ('completed','failed')
		 returning id, parent_session_id, event_type, payload`,
		[childSessionId],
	);
	const row = result.rows[0] as
		| {
				id: string;
				parent_session_id: string;
				event_type: "completed" | "failed";
				payload: { message?: unknown };
		  }
		| undefined;
	if (row)
		await database().query(
			"delete from agent_peer_inbox where recipient_id=$1 and id=$2 and not accepted",
			[row.parent_session_id, row.id],
		);
	return row
		? {
				outcome: row.event_type,
				report:
					typeof row.payload?.message === "string" ? row.payload.message : "",
			}
		: null;
}

/**
 * Asks a running subagent to wrap up: its budget treats the next few steps
 * as its last, or with `now` its next step (it reports at once).
 */
export async function requestSubagentStop(
	sessionId: string,
	options: { readonly now?: boolean } = {},
) {
	await database().query(
		`update agent_session set agent_budget=coalesce(agent_budget,'{}'::jsonb) || jsonb_build_object('stopAtStep', agent_steps + $2::int), updated_at=now()
		 where id=$1 and agent_role is not null`,
		[sessionId, options.now ? 0 : 3],
	);
}
