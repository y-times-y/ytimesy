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

/** Counts one model step against a subagent's budget; returns the new total. */
export async function recordSubagentStep(sessionId: string) {
	const result = await database().query(
		`update agent_session set agent_steps=agent_steps+1
		 where id=$1 and agent_role is not null returning agent_steps`,
		[sessionId],
	);
	return Number(result.rows[0]?.agent_steps ?? 0);
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
 * Forked writer VMs to delete: reported at least `graceMinutes` ago and
 * idle, or whose session is no longer running anything.
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
