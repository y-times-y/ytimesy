// What a hard-set record keeps of a turn before its session is deleted: the
// tool calls per tool name (from the session's items, run_code's inner calls,
// and the model's own tool calls in the turn's messages), so a record shows
// whether agent / find_tools / run_code were used after the eval user is gone.
import {
	CODE_MODE_TOOL,
	codeModeConcurrency,
	codeModeResult,
} from "../../src/domain/code-mode";
import type { SessionItem } from "../../src/domain/session-item";

export type ToolCallSummary = {
	/** Recorded tool calls (the chat's items), per tool name. */
	byTool: Record<string, number>;
	failedByTool: Record<string, number>;
	total: number;
	/** run_code programs and the tool calls they made, per inner tool name. */
	runCode: {
		programs: number;
		innerByTool: Record<string, number>;
		/** Inner calls of each program, in order (absent in older records). */
		innerPerProgram?: number[];
		/** Most inner calls running at once in each program; null when the record has no start times. */
		concurrencyPerProgram?: (number | null)[];
	};
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
		runCode: {
			programs: 0,
			innerByTool: {},
			innerPerProgram: [],
			concurrencyPerProgram: [],
		},
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
			const calls = (codeModeResult(item)?.calls ?? []).filter(
				(call) => call && typeof call.tool === "string",
			);
			for (const call of calls) bump(summary.runCode.innerByTool, call.tool);
			summary.runCode.innerPerProgram?.push(calls.length);
			summary.runCode.concurrencyPerProgram?.push(codeModeConcurrency(calls));
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

/** The record fields the efficiency table reads (a subset of the hard-set record). */
export type EfficiencyInput = {
	readonly task: string;
	readonly attempt: string;
	readonly run?: string;
	readonly variant: string;
	readonly passed: boolean;
	readonly modelSteps: number | null;
	readonly inputTokens: number | null;
	readonly cachedTokens: number | null;
	readonly agentSec: number;
	readonly toolCalls: number;
	readonly toolsUsed?: Record<string, number>;
	readonly toolSummary?: ToolCallSummary | null;
};

export type EfficiencyRow = {
	readonly label: string;
	readonly group: string;
	/** null: not scored (still grading, errored, short budget). */
	readonly passed: boolean | null;
	readonly steps: number | null;
	/** Direct tool calls the model made (items), run_code included. */
	readonly toolCalls: number;
	readonly runCode: number;
	/** Inner calls across programs; null when the record kept no run_code detail. */
	readonly inner: number | null;
	/** Programs with two or more inner calls running at once; null without start times. */
	readonly parallelPrograms: number | null;
	readonly inputTokens: number | null;
	readonly cachedTokens: number | null;
	/** Mean input tokens per model call: the context each step sends. */
	readonly inputPerStep: number | null;
	readonly costUsd: number | null;
	readonly agentSec: number;
};

/**
 * Per run: model calls, run_code programs and their inner calls, input
 * tokens and context per step, cost and agent wall time. Older records
 * (before toolSummary) give run_code from the items' counts and no inner
 * detail.
 */
export function efficiencyRow(
	record: EfficiencyInput,
	costUsd: number | null,
	scored = true,
): EfficiencyRow {
	const summary = record.toolSummary;
	const runCode =
		summary?.runCode.programs ?? record.toolsUsed?.[CODE_MODE_TOOL] ?? 0;
	const inner = summary
		? Object.values(summary.runCode.innerByTool).reduce((a, b) => a + b, 0)
		: runCode
			? null
			: 0;
	const concurrency = summary?.runCode.concurrencyPerProgram;
	const parallelPrograms =
		runCode === 0
			? 0
			: concurrency &&
					concurrency.length === runCode &&
					concurrency.every((value) => value !== null)
				? concurrency.filter((value) => (value ?? 0) >= 2).length
				: null;
	return {
		label: `${record.task}.${record.attempt}`,
		group: record.run ? `${record.run} (${record.variant})` : record.variant,
		passed: scored ? record.passed : null,
		steps: record.modelSteps,
		toolCalls: record.toolCalls,
		runCode,
		inner,
		parallelPrograms,
		inputTokens: record.inputTokens,
		cachedTokens: record.cachedTokens,
		inputPerStep:
			record.inputTokens !== null && record.modelSteps
				? Math.round(record.inputTokens / record.modelSteps)
				: null,
		costUsd,
		agentSec: record.agentSec,
	};
}

const mean = (values: readonly (number | null)[]) => {
	const known = values.filter((value): value is number => value !== null);
	return known.length
		? known.reduce((sum, value) => sum + value, 0) / known.length
		: null;
};

const shown = (value: number | null, digits = 0) =>
	value === null ? "-" : value.toFixed(digits);

/** The efficiency table: one row per run, then one mean row per group (run and variant). */
export function efficiencyTable(rows: readonly EfficiencyRow[]): string[][] {
	const header = [
		"run",
		"group",
		"pass",
		"steps",
		"tools",
		"run_code",
		"inner",
		"inner/prog",
		"parallel",
		"in tok",
		"in/step",
		"est $",
		"agent s",
	];
	const line = (row: {
		label: string;
		group: string;
		pass: string;
		steps: number | null;
		toolCalls: number | null;
		runCode: number | null;
		inner: number | null;
		parallel: number | null;
		inputTokens: number | null;
		inputPerStep: number | null;
		costUsd: number | null;
		agentSec: number | null;
		digits: number;
	}) => [
		row.label,
		row.group,
		row.pass,
		shown(row.steps, row.digits),
		shown(row.toolCalls, row.digits),
		shown(row.runCode, row.digits),
		shown(row.inner, row.digits),
		row.inner !== null && row.runCode
			? (row.inner / row.runCode).toFixed(1)
			: "-",
		shown(row.parallel, row.digits),
		shown(row.inputTokens),
		shown(row.inputPerStep),
		row.costUsd === null ? "-" : `$${row.costUsd.toFixed(3)}`,
		shown(row.agentSec),
	];
	const groups = [...new Set(rows.map((row) => row.group))];
	return [
		header,
		...rows.map((row) =>
			line({
				...row,
				pass: row.passed === null ? "-" : row.passed ? "PASS" : "fail",
				parallel: row.parallelPrograms,
				digits: 0,
			}),
		),
		...groups.map((group) => {
			const members = rows.filter((row) => row.group === group);
			return line({
				label: `mean of ${members.length}`,
				group,
				pass: `${members.filter((row) => row.passed).length}/${members.filter((row) => row.passed !== null).length}`,
				steps: mean(members.map((row) => row.steps)),
				toolCalls: mean(members.map((row) => row.toolCalls)),
				runCode: mean(members.map((row) => row.runCode)),
				inner: mean(members.map((row) => row.inner)),
				parallel: mean(members.map((row) => row.parallelPrograms)),
				inputTokens: mean(members.map((row) => row.inputTokens)),
				inputPerStep: mean(members.map((row) => row.inputPerStep)),
				costUsd: mean(members.map((row) => row.costUsd)),
				agentSec: mean(members.map((row) => row.agentSec)),
				digits: 1,
			});
		}),
	];
}
