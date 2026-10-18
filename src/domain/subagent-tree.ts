import type { AgentProviderId } from "./agent-provider";
import { type AgentTaskStatus, agentTaskTree } from "./agent-task";
import { modelBilling } from "./model-pricing";
import {
	type SessionItem,
	type SessionTurnStatus,
	sessionItemsFromUnknown,
} from "./session-item";
import {
	type SubagentBudget,
	type SubagentFork,
	type SubagentRemaining,
	type SubagentRole,
	subagentLabelFromTaskLabel,
	subagentPlacement,
	subagentRemaining,
} from "./subagent";
import {
	type AgentSpend,
	agentSpend,
	forkVmMinutes,
	subtreeSpends,
	totalSpend,
} from "./subagent-usage";

/** The session fields the tree reads (AgentSessionRecord satisfies it). */
export type SubagentTreeSession = {
	readonly id: string;
	readonly parentSessionId: string | null;
	readonly title: string;
	readonly turnStatus: SessionTurnStatus;
	readonly harness: AgentProviderId;
	readonly listedModelId: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly items: unknown;
	readonly taskState?: AgentTaskStatus | null;
	readonly agentRole?: SubagentRole | null;
	readonly agentBudget?: SubagentBudget | null;
	readonly agentFork?: SubagentFork | null;
	readonly agentSteps?: number;
};

export type SubagentNode = {
	readonly id: string;
	readonly parentId: string;
	/** Positional id: 1, 1.2, 1.2.1. */
	readonly label: string;
	readonly level: number;
	readonly title: string;
	readonly role: SubagentRole;
	readonly vm: "fork" | "shared";
	readonly state: AgentTaskStatus;
	readonly live: boolean;
	readonly steps: number;
	readonly minutes: number;
	readonly budget: SubagentBudget | null;
	/** This agent's own spend. */
	readonly spend: AgentSpend;
	/** Its own plus every descendant's. */
	readonly subtree: AgentSpend;
};

export type SubagentTree = {
	readonly nodes: readonly SubagentNode[];
	/** The whole tree, the builder's own spend included. */
	readonly total: AgentSpend;
	readonly builder: AgentSpend;
};

function sessionSpend(session: SubagentTreeSession, now: number) {
	return agentSpend({
		items: sessionItemsFromUnknown(session.items) as readonly SessionItem[],
		billing: modelBilling({
			harness: session.harness === "codex" ? "codex" : "api",
			modelId: session.listedModelId,
		}),
		vmMinutes: forkVmMinutes(session.agentFork ?? null, now),
	});
}

/**
 * The subagent tree under a root (the builder): every child started through
 * the agent tool, with positional labels, state, budget use and spend.
 * Children from the older task tools are left out.
 */
export function subagentTree(
	rootId: string,
	sessions: readonly SubagentTreeSession[],
	now: number,
): SubagentTree {
	const byId = new Map(sessions.map((session) => [session.id, session]));
	const spends = new Map(
		sessions.map((session) => [session.id, sessionSpend(session, now)]),
	);
	const subtrees = subtreeSpends(
		sessions.map((session) => ({
			id: session.id,
			parentId: session.parentSessionId,
			spend: spends.get(session.id) as AgentSpend,
		})),
	);
	const tasks = agentTaskTree(
		rootId,
		sessions.filter((session) => session.id !== rootId) as never,
	);
	const nodes: SubagentNode[] = [];
	for (const task of tasks) {
		const session = byId.get(task.id);
		if (!session?.agentRole) continue;
		const minutes = Math.max(0, (now - Date.parse(session.createdAt)) / 60_000);
		nodes.push({
			id: task.id,
			parentId: task.parentSessionId,
			label: subagentLabelFromTaskLabel(task.label),
			level: task.depth,
			title: task.title,
			role: session.agentRole,
			vm: subagentPlacement(session.agentRole) === "fork" ? "fork" : "shared",
			state: task.status,
			live: task.status === "working" || task.status === "waiting",
			steps: session.agentSteps ?? 0,
			minutes,
			budget: session.agentBudget ?? null,
			spend: spends.get(task.id) as AgentSpend,
			subtree: subtrees.get(task.id) as AgentSpend,
		});
	}
	const builder = spends.get(rootId) ?? totalSpend([]);
	return {
		nodes,
		builder,
		total: totalSpend([builder, ...nodes.map((node) => node.spend)]),
	};
}

/** What a node has left of its budget (subtree tokens count against it). */
export function subagentNodeRemaining(
	node: SubagentNode,
): SubagentRemaining | null {
	return node.budget
		? subagentRemaining(node.budget, {
				steps: node.steps,
				minutes: node.minutes,
				tokens: node.subtree.tokens,
			})
		: null;
}

/** What the task panel shows for a subagent row (no prompts, no transcripts). */
export type SubagentTaskView = {
	readonly role: SubagentRole;
	readonly vm: "fork" | "shared";
	readonly steps: number;
	readonly minutes: number;
	readonly budget: SubagentBudget | null;
	/** Own spend, children excluded. */
	readonly spend: AgentSpend;
	/** Own plus every descendant's spend. */
	readonly subtree: AgentSpend;
};

/** The subagent view of each node, keyed by session id. */
export function subagentTaskViews(
	rootId: string,
	sessions: readonly SubagentTreeSession[],
	now: number,
): Map<string, SubagentTaskView> {
	return new Map(
		subagentTree(rootId, sessions, now).nodes.map((node) => [
			node.id,
			{
				role: node.role,
				vm: node.vm,
				steps: node.steps,
				minutes: node.minutes,
				budget: node.budget,
				spend: node.spend,
				subtree: node.subtree,
			},
		]),
	);
}
