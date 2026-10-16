import { pendingPlanId } from "./agent-plan";
import type { AgentTodo } from "./agent-todos";
import type { ApiTokenUsage } from "./api-token-usage";
import type { CodexUsage } from "./codex-usage";
import { SessionItemId } from "./ids";
import type { MemoryRecall, SavedMemoryLine } from "./memory-marker";
import type { MessageAttachment } from "./message-attachment";
import type { FailoverReason } from "./model-failover";
import { visibleRuntimeUserText } from "./runtime-handoff";
import type { RequestableSecretKind } from "./secret-request";
import {
	fileChangesFromShellCommand,
	remainingShellCommandAfterWrites,
} from "./shell-file-change";

export type SessionTurnStatus = "idle" | "running" | "completed" | "failed";

export type ToolActivityStatus =
	| "inProgress"
	| "completed"
	| "failed"
	| "declined";

export type UserMessageItem = {
	readonly contextUsage?: Pick<CodexUsage, "context" | "compacting">;
	readonly apiUsage?: ApiTokenUsage;
	readonly kind: "userMessage";
	readonly id: SessionItemId;
	readonly text: string;
	/** Files sent with the message; bytes stay in private storage. */
	readonly attachments?: readonly MessageAttachment[];
	/** The user approved the agent's proposed plan; edits are unlocked. */
	readonly approvesPlan?: true;
	/** Cross-chat memory read for this request; the model saw it as a separate part. */
	readonly memory?: MemoryRecall;
	readonly timing?: {
		readonly startedAt: number;
		readonly completedAt?: number;
	};
};

export type AgentMessageItem = {
	readonly kind: "agentMessage";
	readonly id: SessionItemId;
	readonly text: string;
	readonly streaming?: boolean;
	readonly phase?: "commentary" | "final_answer";
};

export type ReasoningItem = {
	readonly kind: "reasoning";
	readonly id: SessionItemId;
	readonly summaries: readonly string[];
	readonly durationSeconds?: number;
};

export type PlanItem = {
	readonly kind: "plan";
	readonly id: SessionItemId;
	readonly text: string;
	readonly todos?: readonly AgentTodo[];
};

/** A plan the agent proposed with propose_plan; the turn ended to wait for the user. */
export type PlanProposalItem = {
	readonly kind: "planProposal";
	readonly id: SessionItemId;
	readonly text: string;
};

/** A project secret the agent asked for with request_project_secret; the turn ended to wait for the user. */
export type SecretRequestItem = {
	readonly kind: "secretRequest";
	readonly id: SessionItemId;
	readonly name: string;
	readonly secretKind: RequestableSecretKind;
	readonly reason: string;
};

/** Memory lines this turn added: by the agent's own commits or the save hook after it. */
export type MemorySaveItem = {
	readonly kind: "memorySave";
	readonly id: SessionItemId;
	readonly lines: readonly SavedMemoryLine[];
};

export type CommandExecutionItem = {
	readonly kind: "commandExecution";
	readonly id: SessionItemId;
	readonly command: string;
	readonly cwd: string | null;
	readonly status: ToolActivityStatus;
	readonly output: string | null;
	readonly exitCode: number | null;
};

export type FileChangeEntry = {
	readonly path: string;
	readonly change: "add" | "delete" | "update";
	readonly additions: number;
	readonly deletions: number;
	readonly preview: string | null;
};

export type FileChangeItem = {
	readonly kind: "fileChange";
	readonly id: SessionItemId;
	readonly status: ToolActivityStatus;
	readonly changes: readonly FileChangeEntry[];
};

export type McpToolCallItem = {
	readonly kind: "mcpToolCall";
	readonly id: SessionItemId;
	readonly server: string;
	readonly tool: string;
	readonly status: Exclude<ToolActivityStatus, "declined">;
};

export type DynamicToolCallItem = {
	readonly kind: "dynamicToolCall";
	readonly id: SessionItemId;
	readonly tool: string;
	readonly input?: string;
	readonly output?: string;
	readonly status: Exclude<ToolActivityStatus, "declined">;
};

export type WebSearchItem = {
	readonly kind: "webSearch";
	readonly id: SessionItemId;
	readonly query: string | null;
};

export type ErrorSessionItem = {
	readonly kind: "error";
	readonly id: SessionItemId;
	readonly message: string;
};

/**
 * The turn moved to another model route because its own was unavailable, or
 * (awaiting approval) stopped before moving onto a paid API key.
 */
export type ModelSwitchItem = {
	readonly kind: "modelSwitch";
	readonly id: SessionItemId;
	readonly message: string;
	readonly reason: FailoverReason;
	readonly from: { readonly model: string; readonly connection: string };
	readonly to: {
		readonly model: string;
		readonly connection: string;
		/** The route's key (`<connection>|<model>`), sent back to continue on it. */
		readonly key: string;
	};
	readonly state: "switched" | "awaitingApproval";
	/** The turn's usage before the switch; usage after it was served by `to`. */
	readonly usageBefore?: ApiTokenUsage;
};

export type UnknownSessionItem = {
	readonly kind: "unknown";
	readonly id: SessionItemId;
	readonly type: string;
};

export type SessionItem =
	| UserMessageItem
	| AgentMessageItem
	| ReasoningItem
	| PlanItem
	| PlanProposalItem
	| SecretRequestItem
	| MemorySaveItem
	| CommandExecutionItem
	| FileChangeItem
	| McpToolCallItem
	| DynamicToolCallItem
	| WebSearchItem
	| ErrorSessionItem
	| ModelSwitchItem
	| UnknownSessionItem;

export function isTurnRunning(status: SessionTurnStatus): boolean {
	return status === "running";
}

export function liveActivityStatus(
	item: SessionItem,
): ToolActivityStatus | null {
	if (
		item.kind === "commandExecution" ||
		item.kind === "fileChange" ||
		item.kind === "mcpToolCall" ||
		item.kind === "dynamicToolCall"
	) {
		return item.status;
	}
	if (item.kind === "reasoning" && item.durationSeconds == null) {
		return "inProgress";
	}
	return null;
}

export function fileChangesFromSessionItems(
	items: readonly SessionItem[],
): readonly FileChangeEntry[] {
	const latestByPath = new Map<string, FileChangeEntry>();
	for (const item of items) {
		if (item.kind !== "commandExecution") continue;
		for (const change of fileChangesFromShellCommand(item.command)) {
			latestByPath.set(change.path, change);
		}
	}
	for (const item of items) {
		if (item.kind !== "fileChange") continue;
		for (const change of item.changes) {
			latestByPath.set(change.path, change);
		}
	}
	return [...latestByPath.values()];
}

export function lastUserMessageText(
	items: readonly SessionItem[],
): string | null {
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index];
		if (
			item?.kind === "userMessage" &&
			item.text.trim() &&
			!isWorkspacePreamble(item.text)
		) {
			return item.text;
		}
	}
	return null;
}

export function lastAgentMessageText(
	items: readonly SessionItem[],
): string | null {
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index];
		if (item?.kind === "agentMessage" && item.text.trim()) return item.text;
	}
	return null;
}

export function sessionItemsFromUnknown(value: unknown): SessionItem[] {
	return Array.isArray(value)
		? normalizeRuntimeUserMessages(value as SessionItem[])
		: [];
}

function normalizeRuntimeUserMessages(
	items: readonly SessionItem[],
): SessionItem[] {
	return items.map((item) =>
		item.kind === "userMessage"
			? { ...item, text: visibleRuntimeUserText(item.text) }
			: item,
	);
}

/** The transcript already holds the message this send (by its id) adds. */
export function sendWasQueued(
	items: readonly SessionItem[],
	messageId: string | undefined,
): boolean {
	return Boolean(
		messageId &&
			items.some(
				(item) => item.kind === "userMessage" && item.id === messageId,
			),
	);
}

/**
 * Adds the user's message once. The message id is the send's identity, so a
 * replayed request adds nothing while a deliberate repeat ("continue") is new.
 */
export function sessionItemsQueuedWithUser(
	items: readonly SessionItem[],
	text: string,
	messageId?: string,
	approvesPlan?: boolean,
	attachments?: readonly MessageAttachment[],
): SessionItem[] {
	const queued = text.trim();
	if (!queued) return [...items];
	if (sendWasQueued(items, messageId)) return [...items];
	// An approval repeats the same words each time; it is a duplicate only once nothing waits.
	if (approvesPlan && !pendingPlanId(items)) return [...items];
	return [
		...items,
		{
			kind: "userMessage",
			id: SessionItemId(
				messageId ?? `queued-user-${items.length}-${queued.length}`,
			),
			text: queued,
			...(attachments?.length ? { attachments } : {}),
			...(approvesPlan ? { approvesPlan: true as const } : {}),
			timing: { startedAt: Date.now() },
		},
	];
}

function lastUserMessage(
	items: readonly SessionItem[],
): UserMessageItem | null {
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index];
		if (
			item?.kind === "userMessage" &&
			item.text.trim() &&
			!isWorkspacePreamble(item.text)
		) {
			return item;
		}
	}
	return null;
}

/**
 * Whether a server view may replace the open chat while it shows a running turn.
 * A view from before the send landed must not erase the message just sent, so a
 * settled view counts only when it carries that same message (by id). An idle
 * view means the turn was stopped: it counts after the user pressed Stop, or when
 * the server already holds the message and says nothing is running.
 */
export function sessionViewShouldReplaceOpenTurn(input: {
	readonly currentStatus: SessionTurnStatus;
	readonly nextStatus: SessionTurnStatus;
	readonly currentItems: readonly SessionItem[];
	readonly nextItems: readonly SessionItem[];
	readonly stopRequested?: boolean;
}): boolean {
	if (input.currentStatus !== "running") return true;
	if (input.nextStatus === "running") return true;
	if (input.nextStatus === "idle" && input.stopRequested) return true;
	const currentUser = lastUserMessage(input.currentItems);
	// Nothing was sent from here; the server's state is the only truth.
	if (!currentUser) return true;
	const nextUser = lastUserMessage(input.nextItems);
	if (!nextUser || nextUser.id !== currentUser.id) return false;
	if (input.nextStatus === "idle") return true;
	return turnSettledAfterUser(input.nextItems, currentUser.id);
}

function turnSettledAfterUser(
	items: readonly SessionItem[],
	userId: SessionItemId,
): boolean {
	let lastUser = -1;
	for (let index = 0; index < items.length; index += 1) {
		const item = items[index];
		if (item?.kind === "userMessage" && item.id === userId) lastUser = index;
	}
	if (lastUser < 0) return false;
	return items
		.slice(lastUser + 1)
		.some(
			(item) =>
				item.kind === "agentMessage" ||
				item.kind === "error" ||
				(item.kind === "modelSwitch" && item.state === "awaitingApproval"),
		);
}

/**
 * Takes back a send the server never accepted: its message leaves the
 * transcript and the turn returns to where it was before the send.
 */
export function sessionWithoutFailedSend<
	T extends {
		readonly items: readonly SessionItem[];
		readonly turnStatus: SessionTurnStatus;
	},
>(session: T, messageId: string, previousStatus: SessionTurnStatus): T {
	if (!sendWasQueued(session.items, messageId)) return session;
	return {
		...session,
		items: session.items.filter((item) => item.id !== messageId),
		turnStatus:
			session.turnStatus === "running" ? previousStatus : session.turnStatus,
	};
}

export function sessionUsesFollowUpLayout(input: {
	readonly items: readonly SessionItem[];
	readonly turnStatus: SessionTurnStatus;
	readonly listedTitle?: string;
}): boolean {
	return (
		Boolean(lastUserMessageText(input.items)) ||
		input.turnStatus === "running" ||
		Boolean(input.listedTitle && input.listedTitle !== "New session")
	);
}

export function sessionTitleFromItems(items: readonly SessionItem[]): string {
	return sessionTitleFromText(lastUserMessageText(items) ?? "");
}

/** A chat's title from its first message: the first line, shortened. */
export function sessionTitleFromText(text: string): string {
	if (!text) return "New session";
	const line = text.trim().split("\n")[0]?.trim() ?? "";
	if (!line) return "New session";
	return line.length > 48 ? `${line.slice(0, 47)}…` : line;
}

export function visibleSessionItems(
	serverItems: readonly SessionItem[],
	optimisticItems: readonly SessionItem[],
): SessionItem[] {
	if (optimisticItems.length === 0) return [...serverItems];
	return [
		...serverItems,
		...optimisticItems.filter(
			(item) =>
				item.kind !== "userMessage" ||
				!serverItems.some(
					(existing) =>
						existing.kind === "userMessage" && existing.id === item.id,
				),
		),
	];
}

export function compactTimelineItems(
	items: readonly SessionItem[],
): SessionItem[] {
	const presented: SessionItem[] = [];
	for (const item of normalizeRuntimeUserMessages(items)) {
		if (item.kind === "userMessage" && isWorkspacePreamble(item.text)) {
			continue;
		}
		if (item.kind === "commandExecution") {
			presented.push(...presentCommandExecution(item));
			continue;
		}
		presented.push(item);
	}
	return presented;
}

function isWorkspacePreamble(text: string): boolean {
	return text.startsWith("You are in a ytimesy workspace VM.");
}

export function showTurnWorking(
	items: readonly SessionItem[],
	turnStatus: SessionTurnStatus,
): boolean {
	if (turnStatus !== "running") return false;
	const last = compactTimelineItems(items).at(-1);
	if (last == null || last.kind === "userMessage") return true;
	if (
		last.kind === "agentMessage" ||
		last.kind === "error" ||
		last.kind === "memorySave"
	)
		return false;
	if (last.kind === "reasoning") return false;
	if (last.kind === "commandExecution" && last.status === "inProgress") {
		return false;
	}
	if (last.kind === "fileChange" && last.status === "inProgress") {
		return false;
	}
	if (last.kind === "dynamicToolCall" && last.status === "inProgress") {
		return false;
	}
	if (last.kind === "mcpToolCall" && last.status === "inProgress") {
		return false;
	}
	return true;
}

function presentCommandExecution(item: CommandExecutionItem): SessionItem[] {
	const writes = fileChangesFromShellCommand(item.command);
	if (writes.length === 0) return [item];
	const remainder = remainingShellCommandAfterWrites(item.command, writes);
	const files: FileChangeItem = {
		kind: "fileChange",
		id: remainder ? SessionItemId(`${item.id}:files`) : item.id,
		status: item.status,
		changes: writes,
	};
	if (!remainder) return [files];
	return [files, { ...item, command: remainder }];
}
