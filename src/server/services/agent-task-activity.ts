import { backgroundReadChatIds } from "#/domain/agent-panel";
import { parseSteering } from "#/domain/agent-steering";
import { agentTaskTree } from "#/domain/agent-task";
import { recordedContextUsage } from "#/domain/api-progress";
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
import { transcriptItemsForOwner } from "#/server/adapters/agent-session-items";
import {
	agentSessionMetadataForOwner,
	backgroundCommandItemsForOwner,
	descendantAgentSessionMetadata,
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
	// The shape of the tree first, without any transcript: Main's own
	// transcript is never read here (nothing below needs it beyond its
	// background commands), and only the subagents the tree shows have their
	// transcripts read.
	const [rootMetadata, all] = await Promise.all([
		agentSessionMetadataForOwner(userId, rootSessionId),
		descendantAgentSessionMetadata(userId, rootSessionId),
	]);
	if (
		!rootMetadata ||
		rootMetadata.projectId !== projectId ||
		rootMetadata.parentSessionId
	) {
		return { tasks: [], background: {} };
	}
	const root = { ...rootMetadata, items: [] as unknown[] };
	// Subagents only: rows of the retired lead/child architecture (no
	// agent role) and anything under them are not shown.
	const shown = all.filter(
		(session) => session.agentRole && !isSideChat(session),
	);
	const shownIds = agentTaskTree(root.id, shown as never).map(
		(task) => task.id,
	);
	const [transcripts, rootBackgroundItems] = await Promise.all([
		transcriptItemsForOwner(userId, shownIds),
		backgroundCommandItemsForOwner(userId, [root.id]),
	]);
	const descendants = shown.map((session) => ({
		...session,
		items: transcripts.get(session.id) ?? [],
	}));
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
		const items = sessionItemsFromUnknown(byId.get(task.id)?.items);
		const contextUsage = recordedContextUsage(items);
		return {
			...task,
			...(queuedSteering.length ? { queuedSteering } : {}),
			...(contextUsage ? { contextUsage } : {}),
			items: childTaskPublicItems(items),
			turnStatus: byId.get(task.id)?.turnStatus ?? "idle",
			...(subagent ? { subagent } : {}),
		};
	});
	const now = Date.now();
	const sessions = new Map<string, { items: unknown }>([
		[root.id, { items: rootBackgroundItems.get(root.id) ?? [] }],
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
