import { backgroundReadChatIds } from "#/domain/agent-panel";
import { parseSteering } from "#/domain/agent-steering";
import { agentTaskTree } from "#/domain/agent-task";
import {
	type RunningBackgroundCommand,
	runningBackgroundCommands,
} from "#/domain/background-command";
import {
	type AgentTaskActivity,
	childTaskPublicItems,
} from "#/domain/child-task-activity";
import { sessionItemsFromUnknown } from "#/domain/session-item";
import { isSideChat } from "#/domain/side-chat";
import { subagentTaskViews } from "#/domain/subagent-tree";
import {
	agentSessionForOwner,
	descendantAgentSessions,
} from "#/server/adapters/agent-sessions";
import { pendingSteeringMessages } from "#/server/adapters/server-peer-inbox";
import { backgroundCommandMaxSeconds } from "#/server/services/api-command-scope";

/** A chat's helpers with their public transcripts, for its agents list and timeline. */
export async function projectAgentTasks(
	userId: string,
	projectId: string,
	rootSessionId: string,
): Promise<readonly AgentTaskActivity[]> {
	return (
		await projectAgentTasksAndBackground(userId, projectId, rootSessionId)
	).tasks;
}

/**
 * The helpers, and the running background commands of the chat and the
 * helpers the agents list reads (backgroundReadChatIds), from one read of
 * the chat's tree.
 */
export async function projectAgentTasksAndBackground(
	userId: string,
	projectId: string,
	rootSessionId: string,
): Promise<{
	tasks: readonly AgentTaskActivity[];
	background: Record<string, RunningBackgroundCommand[]>;
}> {
	const [root, all] = await Promise.all([
		agentSessionForOwner(userId, rootSessionId),
		descendantAgentSessions(userId, rootSessionId),
	]);
	if (!root || root.projectId !== projectId || root.parentSessionId) {
		return { tasks: [], background: {} };
	}
	// Subagents only: rows of the retired lead/child architecture (no
	// agent role) and anything under them are not shown.
	const descendants = all.filter(
		(session) => session.agentRole && !isSideChat(session),
	);
	const byId = new Map(descendants.map((session) => [session.id, session]));
	const subagents = subagentTaskViews(
		root.id,
		[root, ...descendants],
		Date.now(),
	);
	const pending = await pendingSteeringMessages(
		descendants
			.filter((session) => session.turnStatus === "running")
			.map((session) => session.id),
	).catch(() => []);
	const tasks = agentTaskTree(root.id, descendants).map((task) => {
		const subagent = subagents.get(task.id);
		const queuedSteering = pending.flatMap((row) => {
			if (row.recipientId !== task.id) return [];
			const steering = parseSteering(row.message);
			return steering ? [{ id: row.id, ...steering }] : [];
		});
		return {
			...task,
			...(queuedSteering.length ? { queuedSteering } : {}),
			items: childTaskPublicItems(
				sessionItemsFromUnknown(byId.get(task.id)?.items),
			),
			turnStatus: byId.get(task.id)?.turnStatus ?? "idle",
			...(subagent ? { subagent } : {}),
		};
	});
	const now = Date.now();
	const sessions = new Map([
		[root.id, root],
		...descendants.map((session) => [session.id, session] as const),
	]);
	const background = Object.fromEntries(
		backgroundReadChatIds(root.id, tasks).map((id) => {
			const session = sessions.get(id);
			return [
				id,
				session
					? runningBackgroundCommands(
							sessionItemsFromUnknown(session.items),
							now,
							backgroundCommandMaxSeconds(),
						)
					: [],
			];
		}),
	);
	return { tasks, background };
}
