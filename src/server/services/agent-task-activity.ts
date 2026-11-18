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
	HELPER_OLDER_PAGE,
	HELPER_PAGE,
	publicItemsWithPositions,
	reusableHelperIds,
} from "#/domain/child-task-activity";
import {
	type SessionItem,
	sessionItemsFromUnknown,
} from "#/domain/session-item";
import { USER_MESSAGE_BULK_KEYS } from "#/domain/session-item-projection";
import { isSideChat } from "#/domain/side-chat";
import { subagentTaskViews } from "#/domain/subagent-tree";
import { transcriptPagesForOwner } from "#/server/adapters/agent-session-items";
import {
	agentSessionItemsOfKindsForOwner,
	agentSessionMetadataForOwner,
	backgroundCommandItemsForOwner,
	descendantAgentSessionMetadata,
	itemRowsSinceForOwner,
	itemsRevisionsForOwner,
} from "#/server/adapters/agent-sessions";
import { pendingSteeringMessages } from "#/server/adapters/server-peer-inbox";
import { backgroundCommandMaxSeconds } from "#/server/services/api-command-scope";

/** The items spend, context use and a finished helper's end are read from (turn starts). */
const SPEND_ITEM_KINDS = ["userMessage", "notice"] as const;

/** How a poll wants its helpers' transcripts. */
export type AgentTaskReadMode = {
	/** The browser applies `itemsDelta` (an older page never asks). */
	readonly deltas?: boolean;
	/** Read every helper still read as its last page, not by delta (a safety net). */
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
	// Each helper still read: only the rows written since the revision the
	// browser holds, when it holds one and they are few; else its last page
	// (HELPER_PAGE), never its whole transcript. Spend and context use come
	// from the rows they are made of (the turns' starts) for every helper
	// read, so a subtree's spend stays whole whichever way its transcripts
	// travel. The page still asks for a page read now and then (`fresh`).
	const deltas =
		mode.deltas && !mode.fresh
			? await itemRowsSinceForOwner(
					userId,
					Object.fromEntries(
						open.flatMap((id) =>
							known[id] === undefined ? [] : [[id, known[id] as string]],
						),
					),
				)
			: new Map<string, never>();
	const byDelta = new Map(
		[...deltas].filter(
			([id, delta]) =>
				open.includes(id) &&
				known[id] !== undefined &&
				delta.rows.length <= MAX_DELTA_ROWS &&
				delta.rows.length < delta.count,
		),
	);
	const paged = open.filter((id) => !byDelta.has(id));
	const [pages, backgroundItems, spendItems] = await Promise.all([
		transcriptPagesForOwner(userId, paged, HELPER_PAGE),
		// Background commands from the rows that record them only: a page can
		// leave out an older command that still runs.
		// Only what runningBackgroundCommands reads of each card.
		backgroundCommandItemsForOwner(userId, [root.id, ...shownIds], {
			records: true,
		}),
		agentSessionItemsOfKindsForOwner(userId, open, SPEND_ITEM_KINDS, {
			omit: USER_MESSAGE_BULK_KEYS,
		}),
	]);
	const descendants = shown.map((session) => ({
		...session,
		items: pages.get(session.id)?.items ?? [],
	}));
	const byId = new Map(descendants.map((session) => [session.id, session]));
	const subagents = subagentTaskViews(
		root.id,
		[
			root,
			...descendants.map((session) => ({
				...session,
				items: spendItems.get(session.id) ?? [],
			})),
		],
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
		const delta = byDelta.get(task.id);
		// The latest turn's measurement, recorded on its start.
		const contextUsage = recordedContextUsage(
			sessionItemsFromUnknown(spendItems.get(task.id) ?? []),
		);
		if (delta)
			return {
				...task,
				...(queuedSteering.length ? { queuedSteering } : {}),
				...(subagent ? { subagent } : {}),
				...(contextUsage ? { contextUsage } : {}),
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
		const page = pages.get(task.id);
		const items = sessionItemsFromUnknown(page?.items);
		const first = page?.first ?? 0;
		const shownItems = mode.deltas
			? publicItemsWithPositions(items, first)
			: { items: childTaskPublicItems(items), positions: undefined };
		return {
			...(itemsRev ? { itemsRev } : {}),
			...task,
			...(queuedSteering.length ? { queuedSteering } : {}),
			...(contextUsage ? { contextUsage } : {}),
			items: shownItems.items,
			...(shownItems.positions ? { itemPositions: shownItems.positions } : {}),
			...(mode.deltas && first > 0 ? { itemsFrom: first } : {}),
			turnStatus: byId.get(task.id)?.turnStatus ?? "idle",
			...(subagent ? { subagent } : {}),
		};
	});
	const now = Date.now();
	const readIds = new Set([root.id, ...shownIds]);
	const background = Object.fromEntries(
		backgroundReadChatIds(root.id, tasks).map((id) => [
			id,
			readIds.has(id)
				? runningBackgroundCommands(
						sessionItemsFromUnknown(backgroundItems.get(id) ?? []),
						now,
						backgroundCommandMaxSeconds(),
					)
				: [],
		]),
	);
	return { tasks, background };
}

/**
 * A helper's page before stored position `before` (the oldest the browser
 * holds), as its view shows it, read as the reader scrolls up. Null for a
 * helper that is not the user's or not in the project.
 */
export async function olderHelperItems(
	userId: string,
	projectId: string,
	helperId: string,
	before: number,
): Promise<{
	readonly items: SessionItem[];
	readonly itemPositions: number[];
	readonly itemsFrom: number;
} | null> {
	const helper = await agentSessionMetadataForOwner(userId, helperId);
	if (!helper || helper.projectId !== projectId || !helper.parentSessionId)
		return null;
	const page = (
		await transcriptPagesForOwner(userId, [helperId], {
			...HELPER_OLDER_PAGE,
			before,
		})
	).get(helperId);
	if (!page) return null;
	const shown = publicItemsWithPositions(
		sessionItemsFromUnknown(page.items),
		page.first,
	);
	return {
		items: shown.items,
		itemPositions: shown.positions,
		itemsFrom: page.first,
	};
}
