import { countFileChangeLines, readDiffLineCounts } from "#/domain/diff-stats";
import { SessionItemId } from "#/domain/ids";
import type {
	FileChangeEntry,
	SessionItem,
	SessionTurnStatus,
	ToolActivityStatus,
} from "#/domain/session-item";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function camelType(value: string): string {
	return value.includes("_")
		? value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
		: value;
}

function itemId(value: unknown): SessionItemId | null {
	const id = readString(value);
	return id ? SessionItemId(id) : null;
}

function commandLine(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value
		.filter((part): part is string => typeof part === "string")
		.join(" ");
}

function cwdPath(value: unknown): string | null {
	if (typeof value === "string" && value.length > 0) return value;
	if (isRecord(value)) {
		return readString(value.path) ?? readString(value.uri) ?? null;
	}
	return null;
}

function toolStatus(
	value: unknown,
	fallback: ToolActivityStatus = "inProgress",
): ToolActivityStatus {
	const raw = typeof value === "string" ? camelType(value) : "";
	if (
		raw === "inProgress" ||
		raw === "completed" ||
		raw === "failed" ||
		raw === "declined"
	) {
		return raw;
	}
	return fallback;
}

function runningToolStatus(
	value: unknown,
): Exclude<ToolActivityStatus, "declined"> {
	const status = toolStatus(value);
	return status === "declined" ? "failed" : status;
}

function userMessageText(item: Record<string, unknown>): string {
	const direct = readString(item.text);
	if (direct) return direct;
	if (!Array.isArray(item.content)) return "";
	return item.content
		.flatMap((part) => {
			if (typeof part === "string" && part.trim()) return [part.trim()];
			if (!isRecord(part)) return [];
			const text = readString(part.text);
			return text ? [text] : [];
		})
		.join("\n");
}

function reasoningDurationSeconds(
	item: Record<string, unknown>,
): number | undefined {
	const ms = item.duration_ms ?? item.durationMs;
	if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) {
		return ms / 1000;
	}
	const seconds = item.duration_seconds ?? item.durationSeconds;
	if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
		return seconds;
	}
	return undefined;
}

function reasoningSummaries(item: Record<string, unknown>): string[] {
	const fromFields = [item.summary, item.summary_text, item.content, item.text];
	const summaries: string[] = [];
	for (const field of fromFields) {
		if (typeof field === "string" && field.trim()) {
			summaries.push(field.trim());
			continue;
		}
		if (!Array.isArray(field)) continue;
		for (const entry of field) {
			if (typeof entry === "string" && entry.trim()) {
				summaries.push(entry.trim());
				continue;
			}
			if (!isRecord(entry)) continue;
			const text = readString(entry.text) ?? readString(entry.summary);
			if (text) summaries.push(text);
		}
	}
	return summaries;
}

function fileChangeKind(value: unknown): FileChangeEntry["change"] {
	if (isRecord(value)) {
		return fileChangeKind(value.type ?? value.kind ?? value.change);
	}
	const raw = typeof value === "string" ? value.toLowerCase() : "";
	if (raw === "add" || raw === "added") return "add";
	if (raw === "delete" || raw === "deleted" || raw === "remove")
		return "delete";
	if (raw === "update" || raw === "updated" || raw === "modify")
		return "update";
	return "update";
}

function fileChanges(value: unknown): FileChangeEntry[] {
	if (!Array.isArray(value)) return [];
	const changes: FileChangeEntry[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const path = readString(entry.path);
		if (!path) continue;
		const change = fileChangeKind(entry.kind ?? entry.change);
		const preview = readString(entry.diff) ?? null;
		const counted = countFileChangeLines(change, preview ?? undefined);
		const explicit = readDiffLineCounts(
			entry.additions,
			entry.deletions,
			undefined,
		);
		const counts =
			explicit.additions > 0 || explicit.deletions > 0 ? explicit : counted;
		changes.push({
			path,
			change,
			additions: counts.additions,
			deletions: counts.deletions,
			preview,
		});
	}
	return changes;
}

function notificationDelta(params: Record<string, unknown>): string {
	if (typeof params.delta === "string") return params.delta;
	if (isRecord(params.delta) && typeof params.delta.text === "string") {
		return params.delta.text;
	}
	if (typeof params.output === "string") return params.output;
	if (typeof params.text === "string") return params.text;
	return "";
}

function upsertItem(
	byId: Map<string, Record<string, unknown>>,
	order: string[],
	item: Record<string, unknown>,
): void {
	const id = readString(item.id);
	if (!id) return;
	if (!byId.has(id)) order.push(id);
	byId.set(id, item);
}

function ensureItem(
	byId: Map<string, Record<string, unknown>>,
	order: string[],
	id: string,
	type: string,
): Record<string, unknown> {
	const existing = byId.get(id);
	if (existing) return existing;
	const created = { id, type };
	order.push(id);
	byId.set(id, created);
	return created;
}

function applyReasoningDelta(
	item: Record<string, unknown>,
	params: Record<string, unknown>,
): void {
	const delta = notificationDelta(params);
	if (!delta) return;
	const index =
		typeof params.summaryIndex === "number"
			? params.summaryIndex
			: typeof params.summary_index === "number"
				? params.summary_index
				: 0;
	const summary = Array.isArray(item.summary) ? [...item.summary] : [];
	while (summary.length <= index) summary.push("");
	const current = summary[index];
	if (typeof current === "string") {
		summary[index] = `${current}${delta}`;
	} else if (isRecord(current)) {
		summary[index] = {
			...current,
			text: `${typeof current.text === "string" ? current.text : ""}${delta}`,
		};
	} else {
		summary[index] = delta;
	}
	item.type = item.type ?? "reasoning";
	item.summary = summary;
}

function applyNotificationDelta(
	byId: Map<string, Record<string, unknown>>,
	order: string[],
	method: string,
	params: Record<string, unknown>,
): void {
	const itemIdValue = readString(params.itemId) ?? readString(params.item_id);
	if (!itemIdValue) return;
	const delta = notificationDelta(params);
	if (
		method === "item/agentMessage/delta" ||
		method === "item/agent_message/delta"
	) {
		const item = ensureItem(byId, order, itemIdValue, "agentMessage");
		item.type = "agentMessage";
		item.text = `${typeof item.text === "string" ? item.text : ""}${delta}`;
		return;
	}
	if (method === "item/plan/delta") {
		const item = ensureItem(byId, order, itemIdValue, "plan");
		item.type = "plan";
		item.text = `${typeof item.text === "string" ? item.text : ""}${delta}`;
		return;
	}
	if (
		method === "item/reasoning/summaryTextDelta" ||
		method === "item/reasoning/textDelta"
	) {
		const item = ensureItem(byId, order, itemIdValue, "reasoning");
		applyReasoningDelta(item, params);
		return;
	}
	if (method === "item/commandExecution/outputDelta") {
		const item = byId.get(itemIdValue);
		if (!item) return;
		item.aggregatedOutput = `${typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : ""}${delta}`;
	}
}

/**
 * Merges app-server item lifecycle notifications into the latest payload per
 * item id. `item/completed` overwrites `item/started`; deltas fill in progress
 * before the completed item arrives.
 */
export function collectAppServerItems(
	notifications: readonly unknown[],
): Record<string, unknown>[] {
	const byId = new Map<string, Record<string, unknown>>();
	const order: string[] = [];
	for (const notification of notifications) {
		if (!isRecord(notification)) continue;
		const method =
			typeof notification.method === "string" ? notification.method : "";
		const params = isRecord(notification.params) ? notification.params : {};
		if (isRecord(params.item)) upsertItem(byId, order, params.item);
		if (method === "turn/completed" && isRecord(params.turn)) {
			const items = params.turn.items;
			if (Array.isArray(items)) {
				for (const item of items) {
					if (isRecord(item)) upsertItem(byId, order, item);
				}
			}
		}
		applyNotificationDelta(byId, order, method, params);
	}
	return order.flatMap((id) => {
		const item = byId.get(id);
		return item ? [item] : [];
	});
}

export function sessionItemFromAppServerItem(
	value: unknown,
): SessionItem | null {
	if (!isRecord(value)) return null;
	const id = itemId(value.id);
	if (!id) return null;
	const type = camelType(readString(value.type) ?? "unknown");

	if (type === "userMessage") {
		return { kind: "userMessage", id, text: userMessageText(value) };
	}
	if (type === "agentMessage") {
		return {
			kind: "agentMessage",
			id,
			text: readString(value.text) ?? "",
			...(value.phase === "commentary" || value.phase === "final_answer"
				? { phase: value.phase }
				: {}),
		};
	}
	if (type === "reasoning") {
		const durationSeconds = reasoningDurationSeconds(value);
		return durationSeconds == null
			? { kind: "reasoning", id, summaries: reasoningSummaries(value) }
			: {
					kind: "reasoning",
					id,
					summaries: reasoningSummaries(value),
					durationSeconds,
				};
	}
	if (type === "plan") {
		return { kind: "plan", id, text: readString(value.text) ?? "" };
	}
	if (type === "commandExecution") {
		return {
			kind: "commandExecution",
			id,
			command: commandLine(value.command),
			cwd: cwdPath(value.cwd),
			status: toolStatus(value.status),
			output:
				readString(value.aggregatedOutput) ??
				readString(value.aggregated_output) ??
				null,
			exitCode:
				typeof value.exitCode === "number"
					? value.exitCode
					: typeof value.exit_code === "number"
						? value.exit_code
						: null,
		};
	}
	if (type === "fileChange") {
		return {
			kind: "fileChange",
			id,
			status: toolStatus(value.status, "completed"),
			changes: fileChanges(value.changes),
		};
	}
	if (type === "mcpToolCall") {
		return {
			kind: "mcpToolCall",
			id,
			server: readString(value.server) ?? "mcp",
			tool: readString(value.tool) ?? "tool",
			status: runningToolStatus(value.status),
		};
	}
	if (type === "dynamicToolCall") {
		return {
			kind: "dynamicToolCall",
			id,
			tool: readString(value.tool) ?? readString(value.toolName) ?? "tool",
			status: runningToolStatus(value.status),
		};
	}
	if (type === "webSearch") {
		return {
			kind: "webSearch",
			id,
			query: readString(value.query) ?? null,
		};
	}
	if (type === "error") {
		return {
			kind: "error",
			id,
			message: readString(value.message) ?? readString(value.text) ?? "Error",
		};
	}
	return { kind: "unknown", id, type };
}

export function sessionItemsFromAppServerList(value: unknown): SessionItem[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		const parsed = sessionItemFromAppServerItem(item);
		return parsed ? [parsed] : [];
	});
}

export function sessionItemsFromAppServerNotifications(
	notifications: readonly unknown[],
): SessionItem[] {
	return sessionItemsFromAppServerList(collectAppServerItems(notifications));
}

export function sessionItemsFromLegacyMessages(value: unknown): SessionItem[] {
	if (!Array.isArray(value)) return [];
	const items: SessionItem[] = [];
	for (const row of value) {
		if (!isRecord(row)) continue;
		const role = readString(row.role);
		const text = readString(row.text);
		if (!text || (role !== "user" && role !== "assistant")) continue;
		const id = itemId(row.id) ?? SessionItemId(`${role}:${text}`);
		items.push(
			role === "user"
				? { kind: "userMessage", id, text }
				: { kind: "agentMessage", id, text },
		);
	}
	return items;
}

export function sessionItemsFromDaemonStatus(
	status: Record<string, unknown>,
): SessionItem[] {
	const items = sessionItemsFromAppServerList(status.items);
	const withTurnError = appendTurnErrorItem(items, status.turn);
	if (withTurnError.length > 0) return withTurnError;
	return sessionItemsFromLegacyMessages(status.messages);
}

function appendTurnErrorItem(
	items: SessionItem[],
	turn: unknown,
): SessionItem[] {
	if (!isRecord(turn)) return items;
	const message = readString(turn.error);
	if (!message) return items;
	if (items.some((item) => item.kind === "error" && item.message === message)) {
		return items;
	}
	return [
		...items,
		{
			kind: "error",
			id: SessionItemId("turn-error"),
			message,
		},
	];
}

export function sideSessionItemsFromDaemonStatus(
	status: Record<string, unknown>,
): SessionItem[] {
	return sessionItemsFromAppServerList(status.sideItems);
}

export function sessionTurnStatusFromDaemon(
	value: unknown,
	turnStatus: string | null,
): SessionTurnStatus {
	if (
		value === "idle" ||
		value === "running" ||
		value === "completed" ||
		value === "failed"
	) {
		return value;
	}
	if (
		turnStatus === "error" ||
		turnStatus === "failed" ||
		turnStatus === "timeout"
	) {
		return "failed";
	}
	if (turnStatus === "completed") return "completed";
	if (turnStatus === "started" || turnStatus === "inProgress") return "running";
	return "idle";
}
