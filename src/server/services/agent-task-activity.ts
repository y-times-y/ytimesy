import { backgroundReadChatIds } from "#/domain/agent-panel";
import { parseSteering } from "#/domain/agent-steering";
import { agentTaskTree, taskStatusFromTurn } from "#/domain/agent-task";
import { recordedContextUsage } from "#/domain/api-progress";
import {
	type RunningBackgroundCommand,
	runningBackgroundCommands,
} from "#/domain/background-command";
import {
	type AgentTaskActivity,
	childTaskPublicItems,
	publicItemsWithPositions,
	reusableHelperIds,
} from "#/domain/child-task-activity";
import { sessionItemsFromUnknown } from "#/domain/session-item";
import { isSideChat } from "#/domain/side-chat";
import {
	type SubagentTaskView,
	subagentTaskViews,
} from "#/domain/subagent-tree";
import { transcriptItemsForOwner } from "#/server/adapters/agent-session-items";
import {
	agentSessionMetadataForOwner,
	backgroundCommandItemsForOwner,
	descendantAgentSessionMetadata,
	itemRowsSinceForOwner,
	itemsRevisionsForOwner,
} from "#/server/adapters/agent-sessions";
import { pendingSteeringMessages } from "#/server/adapters/server-peer-inbox";
import { backgroundCommandMaxSeconds } from "#/server/services/api-command-scope";

/** How a poll wants its helpers' transcripts. */
export type AgentTaskReadMode = {
	/** The browser applies `itemsDelta` (an older page never asks). */
	readonly deltas?: boolean;
	/** Read every working helper whole (their spend and context use change as they work). */
	readonly fresh?: boolean;
};

/** A delta is worth it only while it is much smaller than the transcript. */
const MAX_DELTA_ROWS = 200;

/** A chat's helpers with their public transcripts, for its agents list and timeline. */
export async function projectAgentTasks(
	userId: string,
	projectId: string,
	rootSessionId: string,
	known: Readonly<Record<string, string>> = {},
	mode: AgentTaskReadMode = {},
): Promise<readonly AgentTaskActivity[]> {
	return (
		await projectAgentTasksAndBackground(
			userId,
			projectId,
			rootSessionId,
			known,
			mode,
		)
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
	/** Transcript revisions the browser holds (knownHelperRevisions). */
	known: Readonly<Record<string, string>> = {},
	mode: AgentTaskReadMode = {},
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
	// Revisions first, transcripts after: a transcript read is never older
	// than the revision sent with it. Finished helpers whose transcripts the
	// browser already holds are not read again (megabytes on every poll).
	const revisions = await itemsRevisionsForOwner(userId, shownIds);
	const reused = Object.keys(known).length
		? reusableHelperIds(
				root.id,
				shown
					.filter((session) => shownIds.includes(session.id))
					.map((session) => ({
						id: session.id,
						parentSessionId: session.parentSessionId,
						live: ["working", "waiting"].includes(
							taskStatusFromTurn(session.turnStatus, session.taskState),
						),
					})),
				revisions,
				known,
			)
		: new Set<string>();
	const open = shownIds.filter((id) => !reused.has(id));
	// Helpers still working: only the rows written since the revision the
	// browser holds, when every one of them can be answered that way (their
	// spend sums their descendants', so they are read whole together or not
	// at all). The page asks for a whole read now and then (`fresh`) to
	// refresh spend and context use.
	const deltas =
		mode.deltas &&
		!mode.fresh &&
		open.length > 0 &&
		open.every((id) => known[id] !== undefined)
			? await itemRowsSinceForOwner(
					userId,
					Object.fromEntries(open.map((id) => [id, known[id] as string])),
				)
			: null;
	const byDelta =
		deltas &&
		open.every((id) => {
			const delta = deltas.get(id);
			return (
				delta &&
				delta.rows.length <= MAX_DELTA_ROWS &&
				delta.rows.length < delta.count
			);
		})
			? deltas
			: null;
	const [transcripts, rootBackgroundItems] = await Promise.all([
		transcriptItemsForOwner(userId, byDelta ? [] : open),
		// Their background commands, from the rows that record them only.
		backgroundCommandItemsForOwner(userId, [
			root.id,
			...(byDelta ? open : []),
			...reused,
		]),
	]);
	const descendants = shown.map((session) => ({
		...session,
		items: transcripts.get(session.id) ?? [],
	}));
	const byId = new Map(descendants.map((session) => [session.id, session]));
	// Spend needs whole transcripts: not computed from a delta (the browser
	// keeps the last one until its next whole read).
	const subagents = byDelta
		? new Map<string, SubagentTaskView>()
		: subagentTaskViews(root.id, [root, ...descendants], Date.now());
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
		const itemsRev = revisions.get(task.id);
		if (reused.has(task.id))
			return {
				...task,
				...(queuedSteering.length ? { queuedSteering } : {}),
				items: [],
				turnStatus: byId.get(task.id)?.turnStatus ?? "idle",
				...(itemsRev ? { itemsRev } : {}),
				unchanged: true as const,
			};
		const delta = byDelta?.get(task.id);
		if (delta)
			return {
				...task,
				...(queuedSteering.length ? { queuedSteering } : {}),
				items: [],
				turnStatus: byId.get(task.id)?.turnStatus ?? "idle",
				itemsRev: delta.itemsRev,
				itemsDelta: {
					base: known[task.id] as string,
					count: delta.count,
					rows: delta.rows.map((row) => ({
						position: row.position,
						item:
							childTaskPublicItems(sessionItemsFromUnknown([row.item]))[0] ??
							null,
					})),
				},
			};
		const items = sessionItemsFromUnknown(byId.get(task.id)?.items);
		const contextUsage = recordedContextUsage(items);
		const shownItems = mode.deltas
			? publicItemsWithPositions(items)
			: { items: childTaskPublicItems(items), positions: undefined };
		return {
			...(itemsRev ? { itemsRev } : {}),
			...task,
			...(queuedSteering.length ? { queuedSteering } : {}),
			...(contextUsage ? { contextUsage } : {}),
			items: shownItems.items,
			...(shownItems.positions ? { itemPositions: shownItems.positions } : {}),
			turnStatus: byId.get(task.id)?.turnStatus ?? "idle",
			...(subagent ? { subagent } : {}),
		};
	});
	const now = Date.now();
	const sessions = new Map<string, { items: unknown }>([
		[root.id, { items: rootBackgroundItems.get(root.id) ?? [] }],
		// A helper not read whole: only the rows that record its background commands.
		...descendants.map(
			(session) =>
				[
					session.id,
					reused.has(session.id) || byDelta
						? { items: rootBackgroundItems.get(session.id) ?? [] }
						: session,
				] as const,
		),
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
