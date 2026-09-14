import { SessionItemId } from "./ids";
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
	readonly kind: "userMessage";
	readonly id: SessionItemId;
	readonly text: string;
};

export type AgentMessageItem = {
	readonly kind: "agentMessage";
	readonly id: SessionItemId;
	readonly text: string;
};

export type ReasoningItem = {
	readonly kind: "reasoning";
	readonly id: SessionItemId;
	readonly summaries: readonly string[];
};

export type PlanItem = {
	readonly kind: "plan";
	readonly id: SessionItemId;
	readonly text: string;
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
	| CommandExecutionItem
	| FileChangeItem
	| McpToolCallItem
	| DynamicToolCallItem
	| WebSearchItem
	| ErrorSessionItem
	| UnknownSessionItem;

export function isConversationItem(
	item: SessionItem,
): item is UserMessageItem | AgentMessageItem {
	return item.kind === "userMessage" || item.kind === "agentMessage";
}

export function isTurnRunning(status: SessionTurnStatus): boolean {
	return status === "running";
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
		if (item?.kind === "userMessage" && item.text.trim()) return item.text;
	}
	return null;
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
						existing.kind === "userMessage" && existing.text === item.text,
				),
		),
	];
}

export function compactTimelineItems(
	items: readonly SessionItem[],
): SessionItem[] {
	const presented: SessionItem[] = [];
	for (const item of items) {
		if (item.kind === "commandExecution") {
			presented.push(...presentCommandExecution(item));
			continue;
		}
		presented.push(item);
	}
	return presentCodexTurns(presented);
}

export function showTurnWorking(
	items: readonly SessionItem[],
	turnStatus: SessionTurnStatus,
): boolean {
	if (turnStatus !== "running") return false;
	const last = compactTimelineItems(items).at(-1);
	return last == null || last.kind === "userMessage";
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

function presentCodexTurns(items: readonly SessionItem[]): SessionItem[] {
	const compacted: SessionItem[] = [];
	let index = 0;
	while (index < items.length && items[index]?.kind !== "userMessage") {
		const leading = collectUntilUser(items, index);
		compacted.push(...presentTurnBody(leading.items));
		index = leading.next;
	}
	while (index < items.length) {
		const user = items[index];
		if (!user) break;
		compacted.push(user);
		index += 1;
		const body = collectUntilUser(items, index);
		compacted.push(...presentTurnBody(body.items));
		index = body.next;
	}
	return compacted;
}

function collectUntilUser(
	items: readonly SessionItem[],
	start: number,
): { items: SessionItem[]; next: number } {
	const collected: SessionItem[] = [];
	let index = start;
	while (index < items.length) {
		const item = items[index];
		if (!item || item.kind === "userMessage") break;
		collected.push(item);
		index += 1;
	}
	return { items: collected, next: index };
}

function presentTurnBody(body: readonly SessionItem[]): SessionItem[] {
	const reasonings = body.filter(
		(row): row is ReasoningItem => row.kind === "reasoning",
	);
	const agents = body.filter(
		(row): row is AgentMessageItem => row.kind === "agentMessage",
	);
	const tools = body.filter(
		(row) => row.kind !== "reasoning" && row.kind !== "agentMessage",
	);
	const compacted: SessionItem[] = [];
	if (reasonings[0]) {
		compacted.push({
			...reasonings[0],
			summaries: reasonings.flatMap((row) => row.summaries),
		});
	}
	compacted.push(...tools, ...agents);
	return compacted;
}
