import type { AgentTask } from "./agent-task";
import type { CodexUsage } from "./codex-usage";
import type { SessionItem, SessionTurnStatus } from "./session-item";
import type { SubagentTaskView } from "./subagent-tree";

export type AgentTaskActivity = AgentTask & {
	readonly items: readonly SessionItem[];
	readonly turnStatus: SessionTurnStatus;
	/** Its own context window's use, from its latest turn (its task message
	 *  is hidden from `items`, so it travels here). */
	readonly contextUsage?: Pick<CodexUsage, "context" | "compacting">;
	/** Set for children started through the agent tool (subagents=on). */
	readonly subagent?: SubagentTaskView;
	/** Steering (agent_send, or the user from the agents list) its next step has not taken yet. */
	readonly queuedSteering?: readonly {
		readonly id: string;
		readonly from: "parent" | "user";
		readonly text: string;
	}[];
	/** Its transcript's write count: the browser sends it back as `known`. */
	readonly itemsRev?: string;
	/**
	 * The transcript did not change since the `itemsRev` the browser sent:
	 * `items`, `contextUsage` and `subagent` are left out (the browser keeps
	 * its own), so a finished helper's transcript is not read on every poll.
	 */
	readonly unchanged?: true;
};

type HelperShape = {
	readonly id: string;
	readonly parentSessionId: string | null;
	readonly live: boolean;
};

/**
 * The helpers whose transcripts need not be read again: every helper of a
 * subtree under the root is reused only when none of them is working and
 * each one's transcript is still at the revision the browser holds (a
 * helper's spend sums its descendants', so a subtree is read whole or not
 * at all).
 */
export function reusableHelperIds(
	rootId: string,
	helpers: readonly HelperShape[],
	revisions: ReadonlyMap<string, string>,
	known: Readonly<Record<string, string>>,
): Set<string> {
	const byId = new Map(helpers.map((helper) => [helper.id, helper]));
	const topOf = (helper: HelperShape) => {
		let current = helper;
		const seen = new Set<string>();
		while (current.parentSessionId && current.parentSessionId !== rootId) {
			if (seen.has(current.id)) return null;
			seen.add(current.id);
			const parent = byId.get(current.parentSessionId);
			if (!parent) return null;
			current = parent;
		}
		return current.parentSessionId === rootId ? current.id : null;
	};
	const subtrees = new Map<string, string[]>();
	const stale = new Set<string>();
	for (const helper of helpers) {
		const top = topOf(helper);
		if (!top) continue;
		subtrees.set(top, [...(subtrees.get(top) ?? []), helper.id]);
		const revision = revisions.get(helper.id);
		if (helper.live || revision === undefined || known[helper.id] !== revision)
			stale.add(top);
	}
	const reusable = new Set<string>();
	for (const [top, ids] of subtrees)
		if (!stale.has(top)) for (const id of ids) reusable.add(id);
	return reusable;
}

/**
 * The tasks a poll returned, with the transcripts it left out (`unchanged`)
 * taken from the copy the browser holds. Null when one is missing there:
 * the caller reads again without `known`.
 */
export function mergeAgentTaskActivity(
	previous: readonly AgentTaskActivity[] | undefined,
	next: readonly AgentTaskActivity[],
): AgentTaskActivity[] | null {
	const held = new Map((previous ?? []).map((task) => [task.id, task]));
	const merged: AgentTaskActivity[] = [];
	for (const task of next) {
		if (!task.unchanged) {
			merged.push(task);
			continue;
		}
		const before = held.get(task.id);
		if (!before || before.unchanged) return null;
		const { unchanged: _unchanged, ...rest } = task;
		merged.push({
			...rest,
			items: before.items,
			...(before.contextUsage ? { contextUsage: before.contextUsage } : {}),
			...(before.subagent ? { subagent: before.subagent } : {}),
		});
	}
	return merged;
}

/** The transcript revisions a poll sends back (`known`). */
export function knownHelperRevisions(
	tasks: readonly AgentTaskActivity[] | undefined,
): Record<string, string> {
	return Object.fromEntries(
		(tasks ?? []).flatMap((task) =>
			task.itemsRev && !task.unchanged ? [[task.id, task.itemsRev]] : [],
		),
	);
}

const INTERNAL_EVENT_PREFIX = "\u2063ytimesy-child-event:";
export function childTaskEventQueueText(eventId: string) {
	return `${INTERNAL_EVENT_PREFIX}${eventId}`;
}

export function isInternalChildTaskMessage(text: string): boolean {
	return (
		text.startsWith(INTERNAL_EVENT_PREFIX) ||
		((/^[^\n]+ (finished|failed)\. Its final summary is below:\n\n/.test(
			text,
		) ||
			/^[^\n]+ is blocked and needs your decision:\n\n/.test(text)) &&
			(text.endsWith(
				"Inspect its evidence and diff before accepting or publishing the result.",
			) ||
				text.endsWith(
					"Answer the child, escalate to the user if necessary, or revise the plan.",
				)))
	);
}

/** The person's latest request in a chat, skipping internal child-event messages. */
export function latestUserRequestText(items: readonly SessionItem[]) {
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item.kind === "userMessage" && !isInternalChildTaskMessage(item.text))
			return item.text;
	}
	return "";
}

/**
 * The chat as the browser gets it. The hidden message that starts a wake-up
 * turn (a helper's report, a background command's exit) is not user-authored
 * chat, so it becomes a silent wake notice: the timeline still sees where the
 * turn before it ended. Old internal agent notifications are dropped.
 */
export function childTaskPublicItems(
	items: readonly SessionItem[],
): SessionItem[] {
	return items.flatMap((item): SessionItem[] => {
		if (item.kind === "userMessage" && isInternalChildTaskMessage(item.text))
			return [
				{
					kind: "notice",
					id: item.id,
					message: "",
					wake: true,
					...(item.timing ? { timing: item.timing } : {}),
				},
			];
		if (item.kind === "agentMessage" && isInternalChildTaskMessage(item.text))
			return [];
		return [item];
	});
}

/** Where a turn starts: the user's message, or the silent start of a wake-up turn. */
export function startsTurn(item: SessionItem): boolean {
	return item.kind === "userMessage" || isWakeTurnStart(item);
}

export function isWakeTurnStart(item: SessionItem): boolean {
	return (
		(item.kind === "notice" && item.wake === true) ||
		(item.kind === "userMessage" && isInternalChildTaskMessage(item.text))
	);
}

/** When a turn started or ended, as its first item records it. */
export function turnStartTiming(item: SessionItem) {
	return item.kind === "userMessage" || item.kind === "notice"
		? item.timing
		: undefined;
}

/** The chat without the silent starts of wake-up turns (none of them shows). */
export function withoutWakeTurnStarts(
	items: readonly SessionItem[],
): SessionItem[] {
	return childTaskPublicItems(items).filter(
		(item) => !(item.kind === "notice" && item.wake),
	);
}

export function childTaskPromptId(
	task: Pick<AgentTask, "createdAt"> & { readonly id?: string },
	items: readonly SessionItem[],
) {
	let promptId: SessionItem["id"] | undefined;
	for (const item of items) {
		if (item.kind === "userMessage") promptId = item.id;
		if (isTaskCreation(item, task.id)) return promptId;
	}
	const prompts = items.filter((item) => item.kind === "userMessage");
	const createdAt = Date.parse(task.createdAt);
	return prompts
		.filter((item) => item.timing && item.timing.startedAt <= createdAt)
		.at(-1)?.id;
}

/** Prefer durable delegation evidence; old prompts may not carry timestamps. */
export function childTaskAnchorId(
	task: Pick<AgentTask, "id" | "createdAt">,
	items: readonly SessionItem[],
) {
	const creation = items.find((item) => isTaskCreation(item, task.id));
	if (creation) return creation.id;
	const promptId = childTaskPromptId(task, items);
	const promptIndex = items.findIndex((item) => item.id === promptId);
	if (promptIndex < 0) return undefined;
	const nextPrompt = items.findIndex(
		(item, index) => index > promptIndex && item.kind === "userMessage",
	);
	const turn = items.slice(
		promptIndex + 1,
		nextPrompt < 0 ? undefined : nextPrompt,
	);
	return (
		turn
			.filter(
				(item) =>
					item.kind === "dynamicToolCall" && isTaskCreationTool(item.tool),
			)
			.at(-1)?.id ?? promptId
	);
}

function isTaskCreationTool(name: string) {
	return (
		name.endsWith("create_task") ||
		name.endsWith("launch_ready_tasks") ||
		name === "agent"
	);
}

function isTaskCreation(item: SessionItem, taskId?: string) {
	if (
		!taskId ||
		item.kind !== "dynamicToolCall" ||
		!isTaskCreationTool(item.tool) ||
		!item.output
	)
		return false;
	return containsTaskId(item.output, taskId, 0);
}

function containsTaskId(
	value: unknown,
	taskId: string,
	depth: number,
): boolean {
	if (depth > 5) return false;
	if (typeof value === "string") {
		try {
			return containsTaskId(JSON.parse(value), taskId, depth + 1);
		} catch {
			return false;
		}
	}
	if (!value || typeof value !== "object") return false;
	if ("taskId" in value && value.taskId === taskId) return true;
	return Object.values(value).some((nested) =>
		containsTaskId(nested, taskId, depth + 1),
	);
}
