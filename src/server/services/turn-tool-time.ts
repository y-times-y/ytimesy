import { CODE_MODE_TOOL } from "#/domain/code-mode";
import { toolMetricCategory } from "#/domain/harness-performance";

/**
 * One compact JSON log line per durable step ("turn.tool_time"): how much of
 * the step's wall time had at least one tool executing (toolMs) and at least
 * one workspace VM tool executing (vmToolMs), to size pausing the chat's VM
 * while only the model works. Overlapping calls count once (interval union).
 * Ids, tool counts and ms only: no tool names, inputs or outputs. Never
 * throws into the turn.
 */

/** A [start, end) interval in epoch ms. */
export type ToolInterval = readonly [start: number, end: number];

/** Total length of the union of the intervals: overlaps and nesting count once. */
export function intervalUnionMs(intervals: readonly ToolInterval[]): number {
	const sorted = intervals
		.filter(([start, end]) => end > start)
		.sort((a, b) => a[0] - b[0]);
	let total = 0;
	let runStart = Number.NaN;
	let runEnd = Number.NaN;
	for (const [start, end] of sorted) {
		if (Number.isNaN(runEnd) || start > runEnd) {
			if (!Number.isNaN(runEnd)) total += runEnd - runStart;
			runStart = start;
			runEnd = end;
		} else if (end > runEnd) runEnd = end;
	}
	if (!Number.isNaN(runEnd)) total += runEnd - runStart;
	return total;
}

/** Read tools that read the turn's stored records, not the workspace VM. */
const OFF_VM_READS = new Set([
	"read_tool_output",
	"read_environment_report",
	"read_context_archive",
	"search_context_history",
]);

/**
 * Whether a tool runs on the chat's workspace VM: commands, file tools and
 * the browser. A run_code / compose_tools program counts as a whole: it
 * drives the workspace tools and needs the VM awake while it runs.
 */
export function isWorkspaceVmTool(name: string): boolean {
	if (name === CODE_MODE_TOOL || name === "compose_tools") return true;
	const category = toolMetricCategory(name);
	if (category === "command" || category === "edit" || category === "browser")
		return true;
	return category === "read" && !OFF_VM_READS.has(name);
}

export type TurnToolTimeKind = "claude-code" | "codex" | "api";

export function turnToolTime(input: {
	turnId: string;
	step: number;
	startedAt: number;
	now?: () => number;
}) {
	const now = input.now ?? Date.now;
	let kind: TurnToolTimeKind | undefined;
	const done: { interval: ToolInterval; vm: boolean }[] = [];
	const open = new Map<string, { start: number; vm: boolean }>();
	let calls = 0;
	let written = false;
	return {
		/** The step's route kind, once known. */
		setKind(value: TurnToolTimeKind) {
			kind = value;
		},
		/** A tool call started executing; its id must be unique in the step. */
		start(id: string, tool: string) {
			try {
				if (written || open.has(id)) return;
				calls += 1;
				open.set(id, { start: now(), vm: isWorkspaceVmTool(tool) });
			} catch {
				/* Observability cannot interrupt a turn. */
			}
		},
		/** The call ended; unknown or already ended ids are ignored. */
		end(id: string) {
			try {
				const call = open.get(id);
				if (!call) return;
				open.delete(id);
				done.push({ interval: [call.start, now()], vm: call.vm });
			} catch {
				/* Observability cannot interrupt a turn. */
			}
		},
		/** Writes the step's line once; calls still running count up to now. */
		write(outcome: string, log: (line: string) => void = console.info) {
			if (written) return;
			written = true;
			try {
				const end = now();
				const all = [
					...done,
					...[...open.values()].map((call) => ({
						interval: [call.start, end] as ToolInterval,
						vm: call.vm,
					})),
				];
				log(
					JSON.stringify({
						event: "turn.tool_time",
						turnId: input.turnId,
						step: input.step,
						kind: kind ?? "unknown",
						outcome,
						stepMs: Math.max(0, Math.round(end - input.startedAt)),
						toolMs: Math.round(
							intervalUnionMs(all.map((call) => call.interval)),
						),
						vmToolMs: Math.round(
							intervalUnionMs(
								all.filter((call) => call.vm).map((call) => call.interval),
							),
						),
						toolCalls: calls,
						...(open.size > 0 ? { unfinished: open.size } : {}),
					}),
				);
			} catch {
				/* Observability cannot interrupt a turn. */
			}
		},
	};
}

export type TurnToolTime = ReturnType<typeof turnToolTime>;
