import type { SidekickState } from "#/domain/sidekick";
import type {
	SubagentBudget,
	SubagentFork,
	SubagentRole,
} from "#/domain/subagent";
import {
	type AgentSessionRecord,
	agentSessionForOwner,
	descendantAgentSessions,
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

/** The session's ancestors, nearest first (the root last). */
export async function subagentAncestors(
	userId: string,
	sessionId: string,
): Promise<AgentSessionRecord[]> {
	const ancestors: AgentSessionRecord[] = [];
	let current = await agentSessionForOwner(userId, sessionId);
	while (current?.parentSessionId && ancestors.length < 8) {
		const parent = await agentSessionForOwner(userId, current.parentSessionId);
		if (!parent) break;
		ancestors.push(parent);
		current = parent;
	}
	return ancestors;
}

/** The whole tree under a root: the root first, then every descendant. */
export async function subagentTree(
	userId: string,
	rootSessionId: string,
): Promise<AgentSessionRecord[]> {
	const root = await agentSessionForOwner(userId, rootSessionId);
	if (!root) return [];
	return [root, ...(await descendantAgentSessions(userId, rootSessionId))];
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
 * Forked writer VMs to delete: reported at least `graceMinutes` ago and
 * idle, or whose session is no longer running anything. Lead mode
 * fusion's sidekick has no fork (it works in the lead's checkout); an
 * older forked one stays while active.
 */
export async function forkedWritersDueForTeardown(graceMinutes: number) {
	const result = await database().query(
		`select id, user_id, agent_fork->>'vmId' as vm_id
		 from agent_session
		 where agent_role='writer'
		   and agent_fork ? 'vmId'
		   and not (agent_fork ? 'deletedAt')
		   and agent_fork ? 'reportedAt'
		   and (agent_fork->>'reportedAt')::timestamptz < now() - make_interval(mins => $1)
		   and turn_status <> 'running'
		   and not (
		     agent_budget ? 'sidekick'
		     and not (agent_budget->'sidekick' ? 'retired')
		   )
		 limit 32`,
		[graceMinutes],
	);
	return result.rows.map(
		(row: { id: string; user_id: string; vm_id: string }) => ({
			sessionId: row.id,
			userId: row.user_id,
			vmId: row.vm_id,
		}),
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
	const result = await database().query(
		`update agent_task_event set status='delivered', delivered_at=now()
		 where child_session_id=$1 and status='pending' and event_type in ('completed','failed')
		 returning event_type, payload`,
		[childSessionId],
	);
	const row = result.rows[0] as
		| { event_type: "completed" | "failed"; payload: { message?: unknown } }
		| undefined;
	return row
		? {
				outcome: row.event_type,
				report:
					typeof row.payload?.message === "string" ? row.payload.message : "",
			}
		: null;
}

/** Asks a running subagent to wrap up: its budget treats the next few steps as its last. */
export async function requestSubagentStop(sessionId: string) {
	await database().query(
		`update agent_session set agent_budget=coalesce(agent_budget,'{}'::jsonb) || jsonb_build_object('stopAtStep', agent_steps + 3), updated_at=now()
		 where id=$1 and agent_role is not null`,
		[sessionId],
	);
}
