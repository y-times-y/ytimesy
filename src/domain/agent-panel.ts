import { parseSteering } from "./agent-steering";
import type { AgentTaskStatus } from "./agent-task";
import {
	type AgentTaskActivity,
	childTaskPromptId,
	childTaskPublicItems,
	isInternalChildTaskMessage,
} from "./child-task-activity";
import { commandActivityTitle } from "./command-activity-title";
import { fileChangeActivity } from "./file-change-copy";
import type { SessionItem, SessionTurnStatus } from "./session-item";
import type { SubagentRole } from "./subagent";
import { toolActivity } from "./tool-detail";

/**
 * The chat's agents list under the composer: the lead (the chat's own
 * agent) and the helpers it started for the current request, each with a
 * stable name and colour, its status and a live line of what it is doing.
 * Pure rules; the view is src/features/sessions/agent-panel.tsx.
 */

/** Muted dot colours, assigned to helpers in start order. */
export const AGENT_COLORS = [
	"blue",
	"green",
	"amber",
	"violet",
	"rose",
	"teal",
] as const;
export type AgentColor = (typeof AGENT_COLORS)[number] | "lead";

export type HelperKind = "sidekick" | SubagentRole;
export type AgentPanelStatus = "working" | "done" | "failed" | "idle";

/** A steering message to a helper that its next step has not taken yet. */
export type QueuedSteering = {
	readonly id: string;
	readonly from: "parent" | "user";
	readonly text: string;
};

export type AgentPanelRow = {
	/** The helper's session id; the lead's row uses LEAD_ROW_ID. */
	readonly id: string;
	readonly name: string;
	readonly kind: HelperKind | "lead";
	readonly color: AgentColor;
	readonly status: AgentPanelStatus;
	/** One line: what it does now, or how it ended. */
	readonly doing: string;
	readonly queued: number;
	readonly title: string;
};

export const LEAD_ROW_ID = "lead";

type HelperIdentity = Pick<AgentTaskActivity, "id" | "createdAt"> & {
	readonly subagent?: AgentTaskActivity["subagent"];
};

/** Lead mode fusion's sidekick is a writer whose budget carries its sidekick state. */
export function helperKind(task: Pick<AgentTaskActivity, "subagent">) {
	if (task.subagent?.budget?.sidekick) return "sidekick" as const;
	return task.subagent?.role ?? "writer";
}

const KIND_NAMES: Record<HelperKind, string> = {
	sidekick: "Sidekick",
	writer: "Writer",
	researcher: "Researcher",
	reviewer: "Reviewer",
	checker: "Checker",
};

const letter = (index: number) =>
	index < 26
		? String.fromCharCode(65 + index)
		: `${String.fromCharCode(65 + (index % 26))}${Math.floor(index / 26)}`;

/**
 * Names and colours over every helper of the chat, in start order, so a
 * helper keeps both for the whole chat. Sidekicks are lettered (a chat's
 * sidekick can be replaced: Sidekick A, then B); other kinds are plain and
 * numbered only when the chat has several of that kind.
 */
export function helperIdentities(tasks: readonly HelperIdentity[]) {
	const ordered = [...tasks].sort(
		(left, right) =>
			left.createdAt.localeCompare(right.createdAt) ||
			left.id.localeCompare(right.id),
	);
	const totals = new Map<HelperKind, number>();
	for (const task of ordered) {
		const kind = helperKind(task);
		totals.set(kind, (totals.get(kind) ?? 0) + 1);
	}
	const seen = new Map<HelperKind, number>();
	const identities = new Map<
		string,
		{ readonly name: string; readonly kind: HelperKind; color: AgentColor }
	>();
	for (const [index, task] of ordered.entries()) {
		const kind = helperKind(task);
		const position = seen.get(kind) ?? 0;
		seen.set(kind, position + 1);
		const base = KIND_NAMES[kind];
		const name =
			kind === "sidekick"
				? `${base} ${letter(position)}`
				: (totals.get(kind) ?? 0) > 1
					? `${base} ${position + 1}`
					: base;
		identities.set(task.id, {
			name,
			kind,
			color: AGENT_COLORS[index % AGENT_COLORS.length] as AgentColor,
		});
	}
	return identities;
}

export function helperStatus(status: AgentTaskStatus): AgentPanelStatus {
	if (status === "working" || status === "waiting" || status === "draft")
		return "working";
	if (status === "done") return "done";
	if (status === "failed") return "failed";
	return "idle";
}

export function leadStatus(turnStatus: SessionTurnStatus): AgentPanelStatus {
	if (turnStatus === "running") return "working";
	if (turnStatus === "completed") return "done";
	if (turnStatus === "failed") return "failed";
	return "idle";
}

const GERUNDS: Record<string, string> = {
	ran: "running",
	read: "reading",
	viewed: "viewing",
	wrote: "writing",
	created: "creating",
	edited: "editing",
	deleted: "deleting",
	searched: "searching",
	found: "finding",
	waited: "waiting",
	stopped: "stopping",
	opened: "opening",
	took: "taking",
	checked: "checking",
	sent: "sending",
	run: "running",
	check: "checking",
	inspect: "inspecting",
	build: "building",
	install: "installing",
	search: "searching",
	list: "listing",
};

/** "Edited" -> "editing", "Run tests" -> "running tests". */
function gerund(phrase: string) {
	const [first = "", ...rest] = phrase.trim().split(/\s+/);
	const verb = GERUNDS[first.toLowerCase()] ?? first.toLowerCase();
	return [verb, ...rest].join(" ").trim();
}

function commandPhrase(command: string) {
	const title = commandActivityTitle(command);
	if (title === "Run shell command" || title === "Run shell commands")
		return "running a command";
	return gerund(title);
}

/** What one activity item says the agent is doing, present tense. */
export function activityPhrase(item: SessionItem): string | null {
	switch (item.kind) {
		case "commandExecution":
			return commandPhrase(item.command);
		case "fileChange": {
			const change = fileChangeActivity(item.changes);
			return change.name
				? `${gerund(change.verb)} ${change.name}`
				: `editing ${item.changes.length} files`;
		}
		case "mcpToolCall":
			return `using ${item.server}`;
		case "webSearch":
			return "searching the web";
		case "reasoning":
			return "thinking";
		case "dynamicToolCall": {
			if (item.tool === "agent") return "starting a helper";
			if (item.tool === "agent_send") return "messaging a helper";
			const activity = toolActivity(item);
			if (activity.verb === "Ran" && activity.target)
				return commandPhrase(activity.target);
			const verb = gerund(activity.verb);
			if (activity.verb === "Searched" || !activity.target) return verb;
			return `${verb} ${activity.target}`;
		}
		default:
			return null;
	}
}

const isRunningItem = (item: SessionItem) =>
	"status" in item && item.status === "inProgress";

function firstLine(text: string | null | undefined, max = 90) {
	const line =
		text
			?.split("\n")
			.map((part) => part.replace(/^[#>*\-\s]+/, "").trim())
			.find(Boolean) ?? "";
	return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

function lastAgentText(items: readonly SessionItem[]) {
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item?.kind === "agentMessage" && !isInternalChildTaskMessage(item.text))
			return item.text;
	}
	return "";
}

/**
 * The live line under an agent's name. While it works the newest running
 * step wins (its tool's verb and target), then its latest activity; before
 * any activity, its task title. A finished agent shows how it ended.
 */
export function agentDoing(input: {
	readonly status: AgentPanelStatus;
	readonly items: readonly SessionItem[];
	readonly title: string;
	readonly summary?: string | null;
}): string {
	const items = childTaskPublicItems(input.items);
	if (input.status === "done")
		return (
			firstLine(input.summary) || firstLine(lastAgentText(items)) || "finished"
		);
	if (input.status === "failed") {
		const error = [...items].reverse().find((item) => item.kind === "error");
		return error?.kind === "error"
			? `failed: ${firstLine(error.message, 70)}`
			: "failed";
	}
	if (input.status === "idle") return "waiting";
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item && isRunningItem(item)) {
			const phrase = activityPhrase(item);
			if (phrase) return phrase;
		}
	}
	const last = items.at(-1);
	if (!last || last.kind === "userMessage")
		return firstLine(input.title) || "starting";
	if (last.kind === "agentMessage") return "writing its report";
	return activityPhrase(last) ?? "thinking";
}

/** The latest request the user typed in the lead's chat. */
function latestPrompt(items: readonly SessionItem[]) {
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item?.kind === "userMessage" && !isInternalChildTaskMessage(item.text))
			return item;
	}
	return null;
}

/**
 * The helpers of the current request: started for it, still working, or
 * active since it was sent. Finished ones stay until the user's next message.
 */
export function currentRequestHelpers(
	tasks: readonly AgentTaskActivity[],
	leadItems: readonly SessionItem[],
): AgentTaskActivity[] {
	const prompt = latestPrompt(leadItems);
	if (!prompt) return [...tasks];
	const sentAt = prompt.timing?.startedAt;
	return tasks.filter(
		(task) =>
			helperStatus(task.status) === "working" ||
			childTaskPromptId(task, leadItems) === prompt.id ||
			(sentAt !== undefined && Date.parse(task.updatedAt) >= sentAt),
	);
}

export function queuedSteeringFor(task: AgentTaskActivity) {
	return task.queuedSteering ?? [];
}

/** The lead's row, then one per helper of the current request in start order. */
export function agentPanelRows(input: {
	readonly tasks: readonly AgentTaskActivity[];
	readonly leadItems: readonly SessionItem[];
	readonly leadTurnStatus: SessionTurnStatus;
	readonly leadTitle?: string;
}): { readonly lead: AgentPanelRow; readonly helpers: AgentPanelRow[] } {
	const identities = helperIdentities(input.tasks);
	const helpers = currentRequestHelpers(input.tasks, input.leadItems)
		.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
		.map((task): AgentPanelRow => {
			const identity = identities.get(task.id);
			const status = helperStatus(task.status);
			return {
				id: task.id,
				name: identity?.name ?? "Helper",
				kind: identity?.kind ?? "writer",
				color: identity?.color ?? "blue",
				status,
				doing: agentDoing({
					status,
					items: task.items,
					title: task.title,
					summary: task.summary,
				}),
				queued: queuedSteeringFor(task).length,
				title: task.title,
			};
		});
	const status = leadStatus(input.leadTurnStatus);
	return {
		lead: {
			id: LEAD_ROW_ID,
			name: "Lead",
			kind: "lead",
			color: "lead",
			status,
			doing:
				status === "working"
					? agentDoing({ status, items: input.leadItems, title: "" }) ||
						"thinking"
					: helpers.some((helper) => helper.status === "working")
						? "waiting for helpers"
						: status === "failed"
							? "failed"
							: "waiting for you",
			queued: 0,
			title: input.leadTitle ?? "",
		},
		helpers,
	};
}

/** More rows than this and finished helpers fold into "+N done". */
export const AGENT_PANEL_UNFOLDED = 4;

/** Active helpers first; finished ones fold away when the list is long. */
export function foldAgentRows(
	helpers: readonly AgentPanelRow[],
	max = AGENT_PANEL_UNFOLDED,
) {
	const active = helpers.filter(
		(row) => row.status === "working" || row.status === "idle",
	);
	const finished = helpers.filter(
		(row) => row.status === "done" || row.status === "failed",
	);
	if (helpers.length <= max) return { shown: [...helpers], folded: [] };
	return { shown: active, folded: finished };
}

/** "Sidekick A finished: tests pass, 3 files changed". */
export function helperFinishedNote(
	row: Pick<AgentPanelRow, "name" | "status" | "doing">,
) {
	const verb = row.status === "failed" ? "failed" : "finished";
	const detail =
		row.status === "failed"
			? row.doing.replace(/^failed:?\s*/, "")
			: row.doing === "finished"
				? ""
				: row.doing;
	return detail ? `${row.name} ${verb}: ${detail}` : `${row.name} ${verb}`;
}

/** Who sent a message in a helper's transcript: its parent's name, or "You". */
export function steeringSender(
	text: string,
	parentName: string,
): { readonly from: string; readonly text: string } {
	const steering = parseSteering(text);
	if (!steering) return { from: parentName, text };
	return {
		from: steering.from === "user" ? "You" : parentName,
		text: steering.text,
	};
}

/**
 * Where a helper's finish line goes in its parent's timeline: after the
 * last row of the turn it started in, before that turn's closing answer.
 * Undefined when its start is unknown (the line goes last).
 */
export function finishLineAnchorId(
	items: readonly SessionItem[],
	startAnchorId: SessionItem["id"] | undefined,
): SessionItem["id"] | undefined {
	const start = startAnchorId
		? items.findIndex((item) => item.id === startAnchorId)
		: -1;
	if (start < 0) return undefined;
	const next = items.findIndex(
		(item, index) => index > start && item.kind === "userMessage",
	);
	let end = (next < 0 ? items.length : next) - 1;
	if (end > start && items[end]?.kind === "agentMessage") end -= 1;
	return items[end]?.id;
}
