// What a hard-set record keeps of a turn before its session is deleted: the
// tool calls per tool name (from the session's items, run_code's inner calls,
// and the model's own tool calls in the turn's messages), so a record shows
// whether agent / find_tools / run_code were used after the eval user is gone.
import { CODE_MODE_TOOL, codeModeResult } from "../../src/domain/code-mode";
import type { SessionItem } from "../../src/domain/session-item";

export type ToolCallSummary = {
	/** Recorded tool calls (the chat's items), per tool name. */
	byTool: Record<string, number>;
	failedByTool: Record<string, number>;
	total: number;
	/** run_code programs and the tool calls they made, per inner tool name. */
	runCode: { programs: number; innerByTool: Record<string, number> };
	/** Tool calls in the turn's model messages, per tool name (a cross-check of the items). */
	modelByTool: Record<string, number>;
};

const bump = (counts: Record<string, number>, name: string) => {
	counts[name] = (counts[name] ?? 0) + 1;
};

function itemToolName(item: SessionItem) {
	switch (item.kind) {
		case "dynamicToolCall":
			return item.tool;
		case "commandExecution":
			return "command";
		case "fileChange":
			return "file_change";
		case "mcpToolCall":
			return `mcp:${item.tool}`;
		case "webSearch":
			return "web_search";
		default:
			return null;
	}
}

/** Tool-call parts of model messages: AI SDK `tool-call` parts and Responses `function_call` items. */
function modelToolNames(messages: unknown): string[] {
	if (!Array.isArray(messages)) return [];
	const names: string[] = [];
	const visit = (part: unknown) => {
		if (!part || typeof part !== "object") return;
		const value = part as Record<string, unknown>;
		if (value.type === "tool-call" && typeof value.toolName === "string")
			names.push(value.toolName);
		else if (value.type === "function_call" && typeof value.name === "string")
			names.push(value.name);
	};
	for (const message of messages) {
		visit(message);
		const content = (message as { content?: unknown } | null)?.content;
		if (Array.isArray(content)) for (const part of content) visit(part);
	}
	return names;
}

export function toolCallSummary(
	items: readonly SessionItem[],
	messages: unknown,
): ToolCallSummary {
	const summary: ToolCallSummary = {
		byTool: {},
		failedByTool: {},
		total: 0,
		runCode: { programs: 0, innerByTool: {} },
		modelByTool: {},
	};
	for (const item of items) {
		const name = itemToolName(item);
		if (!name) continue;
		summary.total++;
		bump(summary.byTool, name);
		if ("status" in item && item.status === "failed")
			bump(summary.failedByTool, name);
		if (item.kind === "dynamicToolCall" && item.tool === CODE_MODE_TOOL) {
			summary.runCode.programs++;
			for (const call of codeModeResult(item)?.calls ?? [])
				if (call && typeof call.tool === "string")
					bump(summary.runCode.innerByTool, call.tool);
		}
	}
	for (const name of modelToolNames(messages)) bump(summary.modelByTool, name);
	return summary;
}

const counts = (value: Record<string, number>) =>
	Object.entries(value)
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([name, count]) => `${name} ${count}`)
		.join(", ");

/** The tools a variant is about, shown even at zero (did subagents/code mode get used?). */
const WATCHED = ["agent", "find_tools", CODE_MODE_TOOL];

/** One report line per record: its tool calls per name, run_code's inner calls, the watched tools. */
export function toolCallLine(summary: ToolCallSummary | null | undefined) {
	if (!summary) return "no tool-call record";
	const watched = WATCHED.map(
		(name) => `${name} ${summary.byTool[name] ?? 0}`,
	).join(", ");
	const inner = counts(summary.runCode.innerByTool);
	return `${summary.total} call(s): ${counts(summary.byTool) || "none"} [${watched}]${inner ? `; run_code inner: ${inner}` : ""}`;
}
