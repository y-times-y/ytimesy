import { parseSteering } from "./agent-steering";
import type { AgentTaskStatus } from "./agent-task";
import type { RunningBackgroundCommand } from "./background-command";
import {
	type AgentTaskActivity,
	childTaskPromptId,
	childTaskPublicItems,
	isInternalChildTaskMessage,
} from "./child-task-activity";
import { commandActivityTitle } from "./command-activity-title";
import { fileChangeActivity } from "./file-change-copy";
import {
	type AgentIcon,
	type AgentKind,
	agentColor,
	helperIdentitiesOf,
	helperKind,
	KIND_ICONS,
	KIND_TAGS,
	kindShade,
	MAIN_NAME,
} from "./helper-names";
import { sessionBilling, usageCostUsd } from "./model-pricing";
import type { SessionItem, SessionTurnStatus } from "./session-item";
import { splitReportHeader } from "./subagent";
import { toolActivity } from "./tool-detail";

/**
 * The chat's agents list under the composer: the lead (the chat's own
 * agent) and the helpers it started for the current request, each with a
 * stable name and colour, its status and a live line of what it is doing.
 * Pure rules; the view is src/features/sessions/agent-panel.tsx.
 */

export {
	type AgentIcon,
	type AgentKind,
	type HelperKind,
	helperKind,
} from "./helper-names";

/** "free": the lead's turn ended while its helpers or background runs work on. */
export type AgentPanelStatus = "working" | "free" | "done" | "failed" | "idle";

/** Time and tokens on a row's right. */
export type AgentMetric = {
	/** Epoch ms the agent (or the lead's request, or a sidekick's round) started. */
	readonly startedAt: number;
	/** Set once it ended: the time shown is then its total duration. */
	readonly endedAt?: number;
	/** It ended at a time nobody recorded: no time is shown, never a running clock. */
	readonly untimed?: true;
	readonly tokens?: {
		readonly input: number;
		readonly output: number;
		/** Input read from the prompt cache (part of `input`). */
		readonly cached?: number;
		/** Null when a price is unknown. */
		readonly costUsd: number | null;
		/** Plan-billed: the dollars are a list-price estimate. */
		readonly estimated: boolean;
	};
};

/**
 * A background command the chat or one of its helpers started, as its read
 * model gives it (backgroundRunsFromReadModel); adapted into a Background row.
 */
export type BackgroundRun = {
	readonly id: string;
	/** The command, or its short label (backgroundCommandLabel). */
	readonly command: string;
	readonly status: "running" | "exited" | "failed";
	readonly exitCode?: number | null;
	readonly startedAt: number;
	readonly endedAt?: number | null;
};

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
	readonly kind: AgentKind;
	/** Its kind's tag ("Build"); none for Main. */
	readonly tag: string | null;
	readonly icon: AgentIcon;
	/** A CSS colour for its icon and accents (helper-names.ts agentColor). */
	readonly color: string;
	readonly status: AgentPanelStatus;
	/** The short status word on the right ("working", "exited 0"). */
	readonly statusLabel: string;
	/** One line: what it does now, or how it ended. */
	readonly doing: string;
	readonly queued: number;
	readonly title: string;
	readonly metric?: AgentMetric;
	/** The user can write to it: running, or a sidekick resting between rounds. */
	readonly messageable: boolean;
};

export const LEAD_ROW_ID = "lead";

/** Name, tag, icon and colour of every helper of the chat (helper-names.ts). */
export function helperIdentities(
	tasks: readonly Pick<
		AgentTaskActivity,
		"id" | "createdAt" | "title" | "subagent"
	>[],
) {
	return helperIdentitiesOf(
		tasks.map((task) => ({
			id: task.id,
			createdAt: task.createdAt,
			title: task.title,
			kind: helperKind(task),
		})),
	);
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

/** A helper's report without its "[agent 3 writer finished · …]" header line. */
function reportBody(summary: string | null | undefined) {
	return summary ? splitReportHeader(summary).body : summary;
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
			firstLine(reportBody(input.summary)) ||
			firstLine(lastAgentText(items)) ||
			"finished"
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

const STATUS_LABELS: Record<AgentPanelStatus, string> = {
	working: "working",
	free: "free",
	done: "done",
	failed: "failed",
	idle: "idle",
};

/**
 * When a finished agent's last turn ended, as its transcript records it; null
 * for turns from before the end was recorded.
 */
function lastTurnEnd(items: readonly SessionItem[]): number | null {
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item?.kind === "userMessage" && !item.queued)
			return item.timing?.completedAt ?? null;
	}
	return null;
}

/**
 * A helper's time: its sidekick round, or its whole run. A finished one's
 * end is its last turn's recorded end; its row's update time moves on later
 * (its report, its fork's cleanup), so it stands in only for older turns.
 */
export function helperMetric(task: AgentTaskActivity): AgentMetric {
	const round = task.subagent?.budget?.sidekick?.roundStartedAt;
	const startedAt = Date.parse(round ?? task.createdAt);
	const ended = helperStatus(task.status) !== "working";
	const spend = task.subagent?.spend;
	const end = ended
		? (lastTurnEnd(task.items) ?? Date.parse(task.updatedAt))
		: null;
	return {
		startedAt,
		...(end !== null ? { endedAt: Math.max(startedAt, end) } : {}),
		...(spend
			? {
					tokens: {
						input: spend.inputTokens,
						output: spend.outputTokens,
						...(spend.cacheReadTokens ? { cached: spend.cacheReadTokens } : {}),
						costUsd: spend.costUsd,
						estimated: spend.planBilled,
					},
				}
			: {}),
	};
}

/** The lead's time and tokens for the current request (the latest prompt's turn). */
export function leadMetric(input: {
	readonly items: readonly SessionItem[];
	readonly turnStatus: SessionTurnStatus;
	readonly harness?: string | null;
	readonly listedModelId?: string | null;
}): AgentMetric | undefined {
	const prompt = latestPrompt(input.items);
	const startedAt = prompt?.timing?.startedAt;
	if (!prompt || startedAt === undefined) return undefined;
	const usage = prompt.apiUsage;
	// The request's last turn: its own, or a wake-up turn a report started since.
	const completedAt = lastTurnEnd(input.items) ?? undefined;
	const running = input.turnStatus === "running";
	if (!running && !completedAt && !usage) return undefined;
	return {
		startedAt,
		...(running
			? {}
			: completedAt
				? { endedAt: Math.max(startedAt, completedAt) }
				: { untimed: true as const }),
		...(usage
			? {
					tokens: {
						input: usage.inputTokens ?? 0,
						output: usage.outputTokens ?? 0,
						...(usage.cacheReadTokens ? { cached: usage.cacheReadTokens } : {}),
						costUsd: usageCostUsd(
							usage,
							sessionBilling({
								harness: input.harness ?? "api",
								listedModelId: input.listedModelId ?? null,
							}),
						),
						estimated: input.harness === "codex",
					},
				}
			: {}),
	};
}

/** A background command's short name: "dev server", "test suite", or its program. */
export function backgroundLabel(command: string) {
	const text = command.replace(/\s+/g, " ").trim();
	if (
		/\b(dev|serve|start|preview)\b/.test(text) ||
		/\bvite\b(?! build)/.test(text)
	)
		return "dev server";
	if (/\b(test|vitest|jest|pytest)\b/.test(text)) return "test suite";
	if (/\bbuild\b/.test(text)) return "build";
	if (/\b(watch|tsc -w)\b/.test(text)) return "watcher";
	if (/\b(lint|biome|eslint)\b/.test(text)) return "lint";
	const program = text.split(" ")[0]?.split("/").at(-1) ?? "";
	return program || "command";
}

/**
 * The background commands read model (readBackgroundCommandsFn: running
 * commands by chat id, for the chat and its helpers) as list input: each
 * command once, oldest first.
 */
export function backgroundRunsFromReadModel(
	byChat: Readonly<Record<string, readonly RunningBackgroundCommand[]>>,
): BackgroundRun[] {
	const runs = new Map<string, BackgroundRun>();
	for (const commands of Object.values(byChat))
		for (const command of commands)
			runs.set(command.id, {
				id: command.id,
				command: command.label,
				status: command.status,
				startedAt: command.startedAt,
			});
	return [...runs.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/** At most this many chats per read (readBackgroundCommandsFn's limit). */
export const BACKGROUND_READ_MAX_CHATS = 20;

/** The chats whose background commands the list reads: the chat, then its newest helpers. */
export function backgroundReadChatIds(
	chatId: string | undefined,
	helpers: readonly { readonly id: string; readonly createdAt: string }[],
): string[] {
	if (!chatId) return [];
	const newest = [...helpers].sort((left, right) =>
		right.createdAt.localeCompare(left.createdAt),
	);
	return [...new Set([chatId, ...newest.map((helper) => helper.id)])].slice(
		0,
		BACKGROUND_READ_MAX_CHATS,
	);
}

/**
 * How often the list rereads background commands: quickly while the chat or
 * its helpers work (a step records a start or an exit), slower while only
 * commands run (an exit reaches the timeline within a minute between
 * turns), and not at all when nothing runs.
 */
export function backgroundPollMs(input: {
	readonly agentsWorking: boolean;
	readonly running: number;
}): number | false {
	if (input.agentsWorking) return 5_000;
	return input.running > 0 ? 15_000 : false;
}

/** Background commands as rows, named by what they run. */
export function backgroundRows(
	runs: readonly BackgroundRun[],
): AgentPanelRow[] {
	return runs.map((run, index) => {
		const status: AgentPanelStatus =
			run.status === "running"
				? "working"
				: run.status === "failed"
					? "failed"
					: "done";
		return {
			id: `background:${run.id}`,
			name: backgroundLabel(run.command),
			kind: "background",
			tag: KIND_TAGS.background,
			icon: KIND_ICONS.background,
			color: agentColor("background", kindShade(index)),
			status,
			statusLabel:
				run.status === "running"
					? "running"
					: run.status === "failed"
						? "failed"
						: `exited ${run.exitCode ?? 0}`,
			doing: run.command,
			queued: 0,
			title: run.command,
			metric: {
				startedAt: run.startedAt,
				...(run.endedAt ? { endedAt: run.endedAt } : {}),
			},
			messageable: false,
		};
	});
}

/** The lead's row, then one per helper of the current request in start order. */
export function agentPanelRows(input: {
	readonly tasks: readonly AgentTaskActivity[];
	readonly leadItems: readonly SessionItem[];
	readonly leadTurnStatus: SessionTurnStatus;
	readonly leadTitle?: string;
	readonly leadHarness?: string | null;
	readonly leadModelId?: string | null;
	readonly background?: readonly BackgroundRun[];
}): {
	readonly lead: AgentPanelRow;
	readonly helpers: AgentPanelRow[];
	readonly background: AgentPanelRow[];
} {
	const identities = helperIdentities(input.tasks);
	const helpers = currentRequestHelpers(input.tasks, input.leadItems)
		.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
		.map((task): AgentPanelRow => {
			const identity = identities.get(task.id);
			const status = helperStatus(task.status);
			const kind = identity?.kind ?? helperKind(task);
			const restingSidekick =
				kind === "sidekick" &&
				status !== "working" &&
				!!task.subagent?.budget?.sidekick &&
				!task.subagent.budget.sidekick.retired;
			return {
				id: task.id,
				name: identity?.name ?? task.title,
				kind,
				tag: KIND_TAGS[kind],
				icon: KIND_ICONS[kind],
				color: identity?.color ?? agentColor(kind),
				status,
				statusLabel: STATUS_LABELS[status],
				// The name is the task, so the line starts at "starting".
				doing: agentDoing({
					status,
					items: task.items,
					title: "",
					summary: task.summary,
				}),
				queued: queuedSteeringFor(task).length,
				title: task.title,
				metric: helperMetric(task),
				messageable: status === "working" || restingSidekick,
			};
		});
	const background = backgroundRows(input.background ?? []);
	const helpersWork = helpers.some((row) => row.status === "working");
	const othersWork =
		helpersWork || background.some((row) => row.status === "working");
	const turn = leadStatus(input.leadTurnStatus);
	const status: AgentPanelStatus =
		turn === "working" ? "working" : othersWork ? "free" : turn;
	return {
		lead: {
			id: LEAD_ROW_ID,
			name: MAIN_NAME,
			kind: "main",
			tag: null,
			icon: KIND_ICONS.main,
			color: agentColor("main"),
			status,
			statusLabel: STATUS_LABELS[status],
			doing:
				status === "working"
					? agentDoing({ status, items: input.leadItems, title: "" }) ||
						"thinking"
					: status === "free"
						? `free while ${helpersWork ? "helpers work" : "commands run"}`
						: status === "failed"
							? "failed"
							: "waiting for you",
			queued: 0,
			title: input.leadTitle ?? "",
			metric: leadMetric({
				items: input.leadItems,
				turnStatus: input.leadTurnStatus,
				harness: input.leadHarness,
				listedModelId: input.leadModelId,
			}),
			messageable: true,
		},
		helpers,
		background,
	};
}

/** "45s", "2m 05s", "1h 04m". */
export function formatElapsed(ms: number) {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60)
		return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** "850", "9k", "21k", "1.2M". */
export function formatTokens(count: number) {
	if (count < 1000) return String(Math.max(0, Math.round(count)));
	if (count < 999_500) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

/** The right-hand metric: "2m 05s · 21k tokens"; time only without tokens. */
export function metricText(metric: AgentMetric, now: number) {
	const tokens = metric.tokens
		? metric.tokens.input + metric.tokens.output
		: null;
	if (metric.untimed)
		return tokens === null ? "" : `${formatTokens(tokens)} tokens`;
	const time = formatElapsed((metric.endedAt ?? now) - metric.startedAt);
	return tokens === null ? time : `${time} · ${formatTokens(tokens)} tokens`;
}

/** The metric's hover: the input / cached / output split and cost. */
export function metricDetail(metric: AgentMetric) {
	if (!metric.tokens) return null;
	const { input, output, cached, costUsd, estimated } = metric.tokens;
	const cost =
		costUsd === null
			? "cost unknown"
			: `${estimated ? "about " : ""}$${costUsd < 0.01 && costUsd > 0 ? costUsd.toFixed(3) : costUsd.toFixed(2)}${estimated ? " at list price" : ""}`;
	return [
		`${formatTokens(input)} in`,
		cached ? `${formatTokens(cached)} cached` : null,
		`${formatTokens(output)} out`,
		cost,
	]
		.filter(Boolean)
		.join(" · ");
}

/** More rows than this and finished helpers fold into "+N done". */
export const AGENT_PANEL_UNFOLDED = 4;

/** Active helpers first; finished ones fold away when the list is long. */
export function foldAgentRows(
	helpers: readonly AgentPanelRow[],
	max = AGENT_PANEL_UNFOLDED,
) {
	const active = helpers.filter(
		(row) =>
			row.status === "working" ||
			row.status === "idle" ||
			row.status === "free",
	);
	const finished = helpers.filter(
		(row) => row.status === "done" || row.status === "failed",
	);
	if (helpers.length <= max) return { shown: [...helpers], folded: [] };
	return { shown: active, folded: finished };
}

/**
 * A helper's finish line in its parent's chat: "Build the CSV export
 * finished", with how it ended ("tests pass, 3 files changed") and its
 * report's facts (steps, time, tokens) as the detail behind it.
 */
export function helperFinishedLine(
	row: Pick<AgentPanelRow, "name" | "status" | "doing"> & {
		readonly summary?: string | null;
	},
): { readonly text: string; readonly detail: string } {
	const verb = row.status === "failed" ? "failed" : "finished";
	const how =
		row.status === "failed"
			? row.doing.replace(/^failed:?\s*/, "")
			: row.doing === "finished"
				? ""
				: row.doing;
	const meta = row.summary ? splitReportHeader(row.summary).meta : null;
	// The header repeats the outcome and the name ("finished · Fix it · 14 steps · …").
	const name = row.name.replace(/^“|”$/g, "");
	const facts = (meta?.split(" · ") ?? []).filter(
		(part, index) =>
			!(index === 0 && /^(finished|failed|budget exhausted)$/.test(part)) &&
			part !== name,
	);
	return {
		text: `${row.name} ${verb}`,
		detail: [how, ...facts].filter(Boolean).join(" · "),
	};
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
