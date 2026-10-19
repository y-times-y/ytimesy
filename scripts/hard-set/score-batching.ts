// Offline batching score for recorded hard-set transcripts (no network, no
// model calls): model steps per task, run_code's inner calls and concurrency
// per program, and "missed batching": step boundaries whose next step's
// inputs were already known. Reason Agent trajectories for the same tasks
// are scored the same way when given.
//
// node --import tsx scripts/hard-set/score-batching.ts [.ytimesy/hard-set/<run> ...]
//   [--reason <reason_trials.json or its reason/ directory>] [--json]
// (--reason defaults to $YTIMESY_REASON_TRACES; the downloaded Reason traces
// keep each trial at reason/<task>/<trial>/agent/trajectory.json.)
//
// Missed batching is a lower bound: a boundary counts only after a step that
// changed files and observed nothing (every call an edit or write, directly
// or inside run_code, and all succeeded). Its output says only "updated", so
// the next step was already known when it was sent: the edits, and the test
// run after them, could have been one run_code program. Reads, commands and
// failed edits always count as needing their result.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
	CODE_MODE_TOOL,
	codeModeConcurrency,
	codeModeResult,
} from "../../src/domain/code-mode";
import { sessionItemsFromUnknown } from "../../src/domain/session-item";

/** Tools whose successful output carries no information the next step needs. */
const WRITE_ONLY = new Set([
	"edit",
	"write",
	"apply_patch",
	"Edit",
	"Write",
	"replace",
	"write_file",
]);

/** One model step that made tool calls. */
export type ScoredStep = {
	readonly step: number;
	/** Tool names the step called; run_code counts as its inner calls. */
	readonly tools: string[];
	readonly programs: number;
	/** Inner calls of each run_code program in the step. */
	readonly innerPerProgram: number[];
	/** Most inner calls running at once in each program (null without start times). */
	readonly concurrencyPerProgram: (number | null)[];
	/** Every call changed files, none failed, and nothing was read or run. */
	readonly writeOnly: boolean;
};

export type BatchingScore = {
	readonly source: "ytimesy" | "reason";
	readonly run: string;
	readonly task: string;
	readonly passed: boolean | null;
	/** Model steps (with or without tool calls). */
	readonly modelSteps: number;
	readonly toolSteps: number;
	readonly programs: number;
	readonly innerCalls: number;
	readonly innerPerProgram: number[];
	readonly concurrencyPerProgram: (number | null)[];
	/** Step boundaries after a write-only step: inputs of the next step were known. */
	readonly missedBatching: number;
	/** The steps after which batching was missed. */
	readonly missedAfter: number[];
};

/** Missed boundaries: each write-only tool step followed by another tool step. */
export function missedBatching(steps: readonly ScoredStep[]) {
	const after: number[] = [];
	for (let index = 0; index < steps.length - 1; index++)
		if (steps[index]?.writeOnly) after.push(steps[index]?.step as number);
	return after;
}

function score(
	base: Pick<BatchingScore, "source" | "run" | "task" | "passed">,
	steps: readonly ScoredStep[],
	modelSteps: number,
): BatchingScore {
	const missedAfter = missedBatching(steps);
	const innerPerProgram = steps.flatMap((step) => step.innerPerProgram);
	return {
		...base,
		modelSteps,
		toolSteps: steps.length,
		programs: steps.reduce((sum, step) => sum + step.programs, 0),
		innerCalls: innerPerProgram.reduce((sum, count) => sum + count, 0),
		innerPerProgram,
		concurrencyPerProgram: steps.flatMap((step) => step.concurrencyPerProgram),
		missedBatching: missedAfter.length,
		missedAfter,
	};
}

const STEP_ID = /:step-(\d+):/;

/**
 * A ytimesy transcript (`<task>.<attempt>.transcript.json`, hard-set
 * --transcripts): the root session's items, grouped into model steps by
 * their `:step-N:` ids. Review-loop items (no step) are not model steps.
 */
export function scoreTranscript(input: {
	run: string;
	task: string;
	transcript: { items?: unknown };
	record?: { passed?: unknown; modelSteps?: unknown } | null;
}): BatchingScore {
	const items = sessionItemsFromUnknown(input.transcript.items ?? []);
	const steps = new Map<
		number,
		{
			tools: string[];
			innerPerProgram: number[];
			concurrencyPerProgram: (number | null)[];
			writeOnly: boolean;
			programs: number;
		}
	>();
	const modelStepNumbers = new Set<number>();
	for (const item of items) {
		const match = STEP_ID.exec(item.id);
		if (!match) continue;
		const number = Number(match[1]);
		modelStepNumbers.add(number);
		if (item.kind !== "dynamicToolCall") continue;
		const step = steps.get(number) ?? {
			tools: [],
			innerPerProgram: [],
			concurrencyPerProgram: [],
			writeOnly: true,
			programs: 0,
		};
		steps.set(number, step);
		if (item.status === "failed") step.writeOnly = false;
		if (item.tool !== CODE_MODE_TOOL) {
			step.tools.push(item.tool);
			if (!WRITE_ONLY.has(item.tool)) step.writeOnly = false;
			continue;
		}
		const result = codeModeResult(item);
		const calls = (result?.calls ?? []).filter(
			(call) => call && typeof call.tool === "string",
		);
		step.programs++;
		step.innerPerProgram.push(calls.length);
		step.concurrencyPerProgram.push(codeModeConcurrency(calls));
		if (!result?.ok || !calls.length) step.writeOnly = false;
		for (const call of calls) {
			step.tools.push(call.tool);
			if (!WRITE_ONLY.has(call.tool) || call.status !== "completed")
				step.writeOnly = false;
		}
	}
	const ordered = [...steps.entries()]
		.sort(([left], [right]) => left - right)
		.map(([step, value]) => ({ step, ...value }));
	const recorded = Number(input.record?.modelSteps);
	return score(
		{
			source: "ytimesy",
			run: input.run,
			task: input.task,
			passed:
				typeof input.record?.passed === "boolean" ? input.record.passed : null,
		},
		ordered,
		Number.isFinite(recorded) && recorded > 0
			? recorded
			: modelStepNumbers.size,
	);
}

type ReasonToolCall = {
	function_name?: unknown;
	arguments?: { code?: unknown } | null;
};
type ReasonStep = {
	step_id?: unknown;
	source?: unknown;
	tool_calls?: ReasonToolCall[] | null;
	observation?: { results?: { content?: unknown }[] } | null;
};

/** The tools a Reason codemode program calls, read from its source (a loop counts once). */
export function reasonProgramTools(code: string) {
	return [...code.matchAll(/tools\.([A-Za-z_]+)\s*\(/g)].map(
		(match) => match[1] as string,
	);
}

/** Reason reports a program's failure or a rejected call in its observation text. */
function reasonFailed(step: ReasonStep) {
	return (step.observation?.results ?? []).some(
		(result) =>
			typeof result.content === "string" &&
			/"status":"rejected"|Script failed|Error:/.test(result.content),
	);
}

/**
 * A Reason Agent trajectory (agent/trajectory.json, ATIF steps): agent
 * steps are model steps; `codemode` calls are programs. Inner calls are
 * counted from the program source, so a loop counts once (a lower bound),
 * and Reason records no start times, so concurrency is null.
 */
export function scoreReasonTrajectory(input: {
	run: string;
	task: string;
	trajectory: { steps?: ReasonStep[] };
	reward?: unknown;
}): BatchingScore {
	const agentSteps = (input.trajectory.steps ?? []).filter(
		(step) => step.source === "agent",
	);
	const steps: ScoredStep[] = [];
	for (const step of agentSteps) {
		const calls = step.tool_calls ?? [];
		if (!calls.length) continue;
		const tools: string[] = [];
		const innerPerProgram: number[] = [];
		let writeOnly = !reasonFailed(step);
		for (const call of calls) {
			const name = String(call.function_name ?? "");
			if (name === "codemode") {
				const inner = reasonProgramTools(String(call.arguments?.code ?? ""));
				innerPerProgram.push(inner.length);
				tools.push(...inner);
				if (!inner.length || inner.some((tool) => !WRITE_ONLY.has(tool)))
					writeOnly = false;
			} else {
				tools.push(name);
				if (!WRITE_ONLY.has(name)) writeOnly = false;
			}
		}
		steps.push({
			step: Number(step.step_id),
			tools,
			programs: innerPerProgram.length,
			innerPerProgram,
			concurrencyPerProgram: innerPerProgram.map(() => null),
			writeOnly,
		});
	}
	return score(
		{
			source: "reason",
			run: input.run,
			task: input.task,
			passed: typeof input.reward === "number" ? input.reward >= 1 : null,
		},
		steps,
		agentSteps.length,
	);
}

const readJson = (path: string): unknown =>
	JSON.parse(readFileSync(path, "utf8"));

/** Every `<task>.<attempt>.transcript.json` under the run directories, with its record beside it. */
export function loadTranscriptScores(runDirectories: readonly string[]) {
	const scores: BatchingScore[] = [];
	for (const directory of runDirectories) {
		if (!existsSync(directory)) continue;
		for (const name of readdirSync(directory).sort()) {
			const match = /^(.+)\.(\d+)\.transcript\.json$/.exec(name);
			if (!match) continue;
			const recordPath = join(directory, `${match[1]}.${match[2]}.json`);
			scores.push(
				scoreTranscript({
					run: basename(directory),
					task: match[1] as string,
					transcript: readJson(join(directory, name)) as { items?: unknown },
					record: existsSync(recordPath)
						? (readJson(recordPath) as { passed?: unknown })
						: null,
				}),
			);
		}
	}
	return scores;
}

/** Reason trials for the given tasks: `<root>/<task>/<trial>/agent/trajectory.json` (+ meta.json). */
export function loadReasonScores(root: string, tasks: ReadonlySet<string>) {
	const directory = statSync(root).isDirectory()
		? root
		: join(dirname(root), "reason");
	const scores: BatchingScore[] = [];
	if (!existsSync(directory)) return scores;
	for (const task of [...tasks].sort()) {
		const taskDirectory = join(directory, task);
		if (!existsSync(taskDirectory)) continue;
		for (const trial of readdirSync(taskDirectory).sort()) {
			const trajectoryPath = join(
				taskDirectory,
				trial,
				"agent/trajectory.json",
			);
			if (!existsSync(trajectoryPath)) continue;
			const metaPath = join(taskDirectory, trial, "meta.json");
			const meta = existsSync(metaPath)
				? (readJson(metaPath) as { reward?: unknown })
				: {};
			scores.push(
				scoreReasonTrajectory({
					run: trial,
					task,
					trajectory: readJson(trajectoryPath) as { steps?: ReasonStep[] },
					reward: meta.reward,
				}),
			);
		}
	}
	return scores;
}

const mean = (values: readonly number[]) =>
	values.length
		? Math.round(
				(values.reduce((sum, value) => sum + value, 0) / values.length) * 10,
			) / 10
		: null;

/** One table row per score, then Reason's per-task means beside ours. */
export function batchingReport(scores: readonly BatchingScore[]) {
	const header =
		"| source | run | task | pass | model steps | tool steps | programs | inner/program | max concurrency | missed batching (after step) |";
	const rows = scores.map(
		(entry) =>
			`| ${entry.source} | ${entry.run} | ${entry.task} | ${entry.passed === null ? "?" : entry.passed ? "yes" : "no"} | ${entry.modelSteps} | ${entry.toolSteps} | ${entry.programs} | ${entry.innerPerProgram.join(",") || "-"} | ${entry.concurrencyPerProgram.map((value) => value ?? "?").join(",") || "-"} | ${entry.missedBatching}${entry.missedAfter.length ? ` (${entry.missedAfter.join(", ")})` : ""} |`,
	);
	const byTask = new Map<
		string,
		{ ours: BatchingScore[]; reason: BatchingScore[] }
	>();
	for (const entry of scores) {
		const group = byTask.get(entry.task) ?? { ours: [], reason: [] };
		(entry.source === "reason" ? group.reason : group.ours).push(entry);
		byTask.set(entry.task, group);
	}
	const summary = [...byTask.entries()].map(([task, group]) => {
		const describe = (entries: BatchingScore[]) =>
			entries.length
				? `${mean(entries.map((entry) => entry.modelSteps))} steps, ${mean(entries.map((entry) => entry.missedBatching))} missed (${entries.length} run${entries.length === 1 ? "" : "s"}, ${entries.filter((entry) => entry.passed).length} passed)`
				: "-";
		return `| ${task} | ${describe(group.ours)} | ${describe(group.reason)} |`;
	});
	return [
		header,
		"|---|---|---|---|---|---|---|---|---|---|",
		...rows,
		"",
		"| task | ytimesy (mean) | Reason (mean) |",
		"|---|---|---|",
		...summary,
	].join("\n");
}

function main() {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			reason: { type: "string" },
			json: { type: "boolean", default: false },
		},
	});
	const root = resolve(".ytimesy/hard-set");
	const runs = positionals.length
		? positionals.map((path) => resolve(path))
		: existsSync(root)
			? readdirSync(root).map((name) => join(root, name))
			: [];
	const ours = loadTranscriptScores(runs);
	const reasonRoot = values.reason ?? process.env.YTIMESY_REASON_TRACES;
	const reason =
		reasonRoot && existsSync(reasonRoot)
			? loadReasonScores(reasonRoot, new Set(ours.map((entry) => entry.task)))
			: [];
	const scores = [...ours, ...reason];
	if (!ours.length)
		console.warn(
			"No transcripts found (run hard-set with --transcripts, then pass .ytimesy/hard-set/<run>).",
		);
	console.log(
		values.json ? JSON.stringify(scores, null, 1) : batchingReport(scores),
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	main();
