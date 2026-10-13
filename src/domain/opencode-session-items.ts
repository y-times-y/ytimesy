import { fileBasename } from "./file-kind";
import { SessionItemId } from "./ids";
import { activityGlyphForToolName } from "./session-activity";
import type { SessionItem, ToolActivityStatus } from "./session-item";

/**
 * OpenCode `/session/:id/message` is `{ info, parts }[]`. Map those parts onto
 * ytimesy timeline items while the turn is still running so the UI is not
 * stuck on a generic Thinking row until the final assistant text lands.
 */
export function sessionItemsFromOpenCodeMessages(
	payload: unknown,
): SessionItem[] {
	const items: SessionItem[] = [];
	for (const row of openCodeMessageRows(payload)) {
		items.push(...itemsFromOpenCodeMessage(row));
	}
	return items;
}

function itemsFromOpenCodeMessage(row: unknown): SessionItem[] {
	if (!isRecord(row)) return [];
	const info = isRecord(row.info) ? row.info : row;
	const role = readNonEmpty(info.role);
	const messageId =
		readNonEmpty(info.id) ?? readNonEmpty(row.id) ?? "opencode-message";
	const parts = Array.isArray(row.parts)
		? row.parts
		: Array.isArray(info.parts)
			? info.parts
			: [];
	const completedMs =
		timestampMs(info, "completed") ?? timestampMs(row, "completed");
	const createdMs = timestampMs(info, "created") ?? timestampMs(row, "created");
	const reasoningDuration =
		completedMs != null && createdMs != null && completedMs > createdMs
			? (completedMs - createdMs) / 1000
			: completedMs != null
				? 1
				: undefined;
	const items: SessionItem[] = [];
	for (const [index, part] of parts.entries()) {
		const mapped = itemFromOpenCodePart({
			part,
			role,
			id: `${messageId}:${index}`,
			reasoningDuration,
		});
		if (mapped) items.push(mapped);
	}
	return items;
}

function itemFromOpenCodePart(input: {
	readonly part: unknown;
	readonly role: string | undefined;
	readonly id: string;
	readonly reasoningDuration?: number;
}): SessionItem | null {
	if (!isRecord(input.part)) return null;
	const type = readNonEmpty(input.part.type);
	if (type === "step-start" || type === "step-finish") return null;
	if (type === "text") {
		const text = readNonEmpty(input.part.text);
		if (!text) return null;
		if (input.role === "user") {
			return {
				kind: "userMessage",
				id: SessionItemId(partId(input.part, input.id)),
				text,
			};
		}
		return {
			kind: "agentMessage",
			id: SessionItemId(partId(input.part, input.id)),
			text,
		};
	}
	if (type === "reasoning") {
		const text = readNonEmpty(input.part.text);
		if (!text) {
			if (input.reasoningDuration == null) {
				return {
					kind: "reasoning",
					id: SessionItemId(partId(input.part, input.id)),
					summaries: [],
				};
			}
			return null;
		}
		return {
			kind: "reasoning",
			id: SessionItemId(partId(input.part, input.id)),
			summaries: [text],
			...(input.reasoningDuration != null
				? { durationSeconds: input.reasoningDuration }
				: {}),
		};
	}
	if (type === "tool" || type === "tool-invocation") {
		return itemFromOpenCodeTool(input.part, input.id);
	}
	if (type === "source-url") {
		const query =
			readNonEmpty(input.part.title) ?? readNonEmpty(input.part.url);
		return {
			kind: "webSearch",
			id: SessionItemId(partId(input.part, input.id)),
			query: query ?? null,
		};
	}
	return null;
}

function itemFromOpenCodeTool(
	part: Record<string, unknown>,
	fallbackId: string,
): SessionItem | null {
	const invocation = isRecord(part.toolInvocation) ? part.toolInvocation : part;
	const tool =
		readNonEmpty(part.tool) ??
		readNonEmpty(invocation.toolName) ??
		readNonEmpty(invocation.tool) ??
		"tool";
	const id = partId(part, readNonEmpty(part.callID) ?? fallbackId);
	const state = isRecord(part.state) ? part.state : invocation;
	const status = toolStatusFromOpenCode(state);
	const args = isRecord(state.input)
		? state.input
		: isRecord(invocation.args)
			? invocation.args
			: isRecord(part.input)
				? part.input
				: {};
	const output =
		readNonEmpty(state.output) ??
		readNonEmpty(state.result) ??
		(typeof invocation.result === "string" ? invocation.result : null);
	const glyph = activityGlyphForToolName(tool);
	if (glyph === "shell") {
		const command =
			readNonEmpty(args.command) ?? readNonEmpty(args.cmd) ?? tool;
		return {
			kind: "commandExecution",
			id: SessionItemId(id),
			command,
			cwd: readNonEmpty(args.workdir) ?? readNonEmpty(args.cwd) ?? null,
			status,
			output,
			exitCode:
				typeof state.exitCode === "number"
					? state.exitCode
					: typeof args.exitCode === "number"
						? args.exitCode
						: status === "completed"
							? 0
							: null,
		};
	}
	if (glyph === "web") {
		return {
			kind: "webSearch",
			id: SessionItemId(id),
			query:
				readNonEmpty(args.query) ??
				readNonEmpty(args.url) ??
				readNonEmpty(args.pattern) ??
				null,
		};
	}
	return {
		kind: "dynamicToolCall",
		id: SessionItemId(id),
		tool: openCodeToolTitle(tool, args),
		status: status === "declined" ? "failed" : status,
	};
}

function openCodeToolTitle(
	tool: string,
	args: Record<string, unknown>,
): string {
	const path =
		readNonEmpty(args.path) ??
		readNonEmpty(args.filePath) ??
		readNonEmpty(args.file) ??
		readNonEmpty(args.target);
	if (path) return `${tool} ${fileBasename(path)}`;
	const query =
		readNonEmpty(args.pattern) ??
		readNonEmpty(args.query) ??
		readNonEmpty(args.glob);
	if (query) return `${tool} ${query}`;
	return tool;
}

function toolStatusFromOpenCode(
	state: Record<string, unknown>,
): ToolActivityStatus {
	const raw =
		readNonEmpty(state.status) ??
		readNonEmpty(state.state) ??
		(typeof state.status === "string" ? state.status : undefined);
	if (
		raw === "pending" ||
		raw === "running" ||
		raw === "call" ||
		raw === "partial-call" ||
		raw === "inProgress"
	) {
		return "inProgress";
	}
	if (raw === "error" || raw === "failed") return "failed";
	if (raw === "declined") return "declined";
	if (raw === "completed" || raw === "result") return "completed";
	return "inProgress";
}

function partId(part: Record<string, unknown>, fallback: string): string {
	return readNonEmpty(part.id) ?? fallback;
}

function timestampMs(
	value: Record<string, unknown>,
	key: "created" | "completed",
): number | undefined {
	const time = isRecord(value.time) ? value.time : value;
	const direct = time[key];
	if (typeof direct === "number" && Number.isFinite(direct) && direct > 0) {
		return direct > 1_000_000_000_000 ? direct : direct * 1000;
	}
	return undefined;
}

function openCodeMessageRows(payload: unknown): unknown[] {
	if (Array.isArray(payload)) return payload;
	if (!isRecord(payload)) return [];
	if (Array.isArray(payload.messages)) return payload.messages;
	if (Array.isArray(payload.data)) return payload.data;
	if (isRecord(payload.info) && Array.isArray(payload.parts)) return [payload];
	return [];
}

function readNonEmpty(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
