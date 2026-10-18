// Pure parts of the instruction-tuning runner (docs/instruction-tuning.md):
// the interleaved schedule, resumption, the per-model ranking and the round
// estimate. scripts/instruction-tuning.ts runs the schedule through
// scripts/hard-set.ts child processes.
import { runListPrice } from "../../src/domain/eval-cost";
import type { InstructionProfile } from "../../src/domain/instruction-profiles";
import { type HardSetRecord, isScored } from "../hard-set/records";
import { hardSetRoute, recordPricing } from "../hard-set/route";
import { HARD_SET_CHUNKS, type HardSetTask } from "../hard-set/tasks";

/** One hard-set invocation: one model, one profile, ≤10 minutes of wall time. */
export type TuningJob = {
	model: string;
	variant: InstructionProfile;
	tasks: string[];
	repeat: number;
	run: string;
};

/** The hard-set run name holding one (model, profile)'s records; repeats are attempts. */
export function tuningRunName(
	prefix: string,
	model: string,
	variant: InstructionProfile,
) {
	const name = `${prefix}.${model.replaceAll("/", "_")}.${variant}`;
	if (!/^[A-Za-z0-9._=-]{1,80}$/.test(name))
		throw new Error(`Run name "${name}" is not a valid hard-set --run name.`);
	return name;
}

/**
 * Tasks per invocation. Codex runs a hard-set chunk (≤4 tasks side by side,
 * one ten-minute invocation); a Gemini free-tier key runs one task at a time,
 * so each invocation holds one task to stay within ten minutes.
 */
export function batchesFor(model: string, tasks: readonly HardSetTask[]) {
	const ids = new Set(tasks.map((task) => task.id));
	if (hardSetRoute(model).kind === "google")
		return tasks.map((task) => [task.id]);
	return HARD_SET_CHUNKS.map((chunk) =>
		chunk.filter((id) => ids.has(id)),
	).filter((chunk) => chunk.length);
}

/**
 * Every (model, profile, batch, repeat) invocation, interleaved so that each
 * profile runs every batch close in time to the others (same infrastructure
 * and quota conditions) and no profile always goes first: per batch, the
 * profile order rotates by batch and repeat. Models alternate job by job.
 */
export function tuningSchedule(input: {
	prefix: string;
	models: readonly string[];
	variants: readonly InstructionProfile[];
	tasks: readonly HardSetTask[];
	repeats: number;
}): TuningJob[] {
	const perModel = input.models.map((model) => {
		const jobs: TuningJob[] = [];
		const batches = batchesFor(model, input.tasks);
		for (let repeat = 1; repeat <= input.repeats; repeat++)
			batches.forEach((tasks, index) => {
				const shift = (index + repeat - 1) % input.variants.length;
				const order = [
					...input.variants.slice(shift),
					...input.variants.slice(0, shift),
				];
				for (const variant of order)
					jobs.push({
						model,
						variant,
						tasks,
						repeat,
						run: tuningRunName(input.prefix, model, variant),
					});
			});
		return jobs;
	});
	const merged: TuningJob[] = [];
	for (let index = 0; perModel.some((jobs) => index < jobs.length); index++)
		for (const jobs of perModel)
			if (index < jobs.length) merged.push(jobs[index]);
	return merged;
}

/**
 * The tasks a job still needs: a task's repeat r is done once its run holds r
 * attempts that are scored or still grading. Rerunning the same --run resumes
 * after a usage limit without redoing finished work.
 */
export function remainingTasks(
	job: TuningJob,
	records: readonly HardSetRecord[],
): string[] {
	return job.tasks.filter(
		(task) =>
			records.filter(
				(record) =>
					record.task === task &&
					(isScored(record) || record.status === "grading"),
			).length < job.repeat,
	);
}

export type VariantSummary = {
	variant: InstructionProfile;
	scored: number;
	passed: number;
	byCategory: Record<string, { scored: number; passed: number }>;
	/** Mean agent seconds of passing attempts. */
	meanPassSec: number | null;
	/** Input + output tokens over all scored attempts, per solved task. */
	tokensPerSolved: number | null;
	cachedPercent: number | null;
	/** List-price dollars over all scored attempts, per solved task. */
	costPerSolved: number | null;
	/** Pass rate on the tasks every compared profile has scored. */
	commonRate: number | null;
	/** Against baseline, per common task: higher pass rate (wins) or lower (losses). */
	wins: number;
	losses: number;
};

const sum = (values: number[]) =>
	values.reduce((total, value) => total + value, 0);

function recordCost(record: HardSetRecord) {
	if (record.inputTokens === null) return null;
	return runListPrice({
		...recordPricing(record.model),
		inputTokens: record.inputTokens,
		cachedTokens: record.cachedTokens ?? null,
		outputTokens: record.outputTokens ?? null,
	}).costUsd;
}

/** Per-task pass rate over scored attempts. */
function taskRates(records: readonly HardSetRecord[]) {
	const rates = new Map<string, number>();
	for (const task of new Set(records.map((record) => record.task))) {
		const attempts = records.filter((record) => record.task === task);
		rates.set(
			task,
			attempts.filter((record) => record.passed).length / attempts.length,
		);
	}
	return rates;
}

/**
 * One model's profiles ranked by pass rate on the tasks all of them scored
 * (then cost and time per solved task). Records must be one model's.
 */
export function rankVariants(
	byVariant: ReadonlyMap<InstructionProfile, readonly HardSetRecord[]>,
): VariantSummary[] {
	const scoredBy = new Map(
		[...byVariant].map(([variant, records]) => [
			variant,
			records.filter((record) => isScored(record) && record.mode === "agent"),
		]),
	);
	const taskSets = [...scoredBy.values()].map(
		(records) => new Set(records.map((record) => record.task)),
	);
	const common = taskSets.length
		? [...taskSets[0]].filter((task) => taskSets.every((set) => set.has(task)))
		: [];
	const baseline = taskRates(scoredBy.get("baseline") ?? []);
	const summaries = [...scoredBy].map(([variant, scored]): VariantSummary => {
		const passed = scored.filter((record) => record.passed);
		const byCategory: VariantSummary["byCategory"] = {};
		for (const record of scored) {
			byCategory[record.category] ??= { scored: 0, passed: 0 };
			byCategory[record.category].scored++;
			if (record.passed) byCategory[record.category].passed++;
		}
		const tokens = sum(
			scored.map(
				(record) => (record.inputTokens ?? 0) + (record.outputTokens ?? 0),
			),
		);
		const input = sum(scored.map((record) => record.inputTokens ?? 0));
		const cached = sum(scored.map((record) => record.cachedTokens ?? 0));
		const costs = scored.map(recordCost);
		const rates = taskRates(scored);
		const commonRates = common.map((task) => rates.get(task) ?? 0);
		let wins = 0;
		let losses = 0;
		if (variant !== "baseline")
			for (const task of common) {
				const delta = (rates.get(task) ?? 0) - (baseline.get(task) ?? 0);
				if (delta > 0) wins++;
				if (delta < 0) losses++;
			}
		return {
			variant,
			scored: scored.length,
			passed: passed.length,
			byCategory,
			meanPassSec: passed.length
				? Math.round(
						sum(passed.map((record) => record.agentSec)) / passed.length,
					)
				: null,
			tokensPerSolved: passed.length
				? Math.round(tokens / passed.length)
				: null,
			cachedPercent: input ? Math.round((cached / input) * 100) : null,
			costPerSolved:
				passed.length && costs.every((cost) => cost !== null)
					? sum(costs as number[]) / passed.length
					: null,
			commonRate: common.length ? sum(commonRates) / common.length : null,
			wins,
			losses,
		};
	});
	return summaries.sort(
		(a, b) =>
			(b.commonRate ?? -1) - (a.commonRate ?? -1) ||
			(a.costPerSolved ?? Number.POSITIVE_INFINITY) -
				(b.costPerSolved ?? Number.POSITIVE_INFINITY) ||
			(a.meanPassSec ?? Number.POSITIVE_INFINITY) -
				(b.meanPassSec ?? Number.POSITIVE_INFINITY),
	);
}

/**
 * Whether the round supports changing a family's profile. A difference of one
 * or two tasks is noise (our TB4 trials of one task often split 2/5 or 3/5),
 * so a profile must beat baseline by at least three common tasks' worth of
 * passes, over three or more repeats, with more paired wins than losses.
 */
export function recommendation(
	ranked: readonly VariantSummary[],
	commonTasks: number,
	repeats: number,
): string {
	const baseline = ranked.find((row) => row.variant === "baseline");
	const best = ranked[0];
	if (
		!baseline ||
		!best ||
		baseline.commonRate === null ||
		best.commonRate === null
	)
		return "No comparison: baseline or a scored profile is missing.";
	if (best.variant === "baseline")
		return "Keep baseline: no profile beat it on the common tasks.";
	const margin = (best.commonRate - baseline.commonRate) * commonTasks;
	const detail = `${best.variant} leads baseline by ${margin.toFixed(1)} task(s) on ${commonTasks} common tasks (${best.wins} paired wins, ${best.losses} losses) over ${repeats} repeat(s)`;
	if (margin < 3 || best.wins <= best.losses)
		return `Keep baseline: ${detail}, within noise (1-2 tasks). Run more repeats before changing it.`;
	if (repeats < 3)
		return `Promising: ${detail}. Repeat to 3+ before setting it in INSTRUCTION_PROFILE_BY_FAMILY.`;
	return `Adopt ${best.variant} for this family: ${detail}. Set it in INSTRUCTION_PROFILE_BY_FAMILY and confirm with one more round against baseline.`;
}

/** Measured inputs for the --plan estimate (docs/hard-set.md, docs/instruction-tuning.md). */
export const ROUND_FACTS = {
	/** One hard-set invocation's wall-time ceiling (minutes). */
	invocationMinutes: 10,
	/** Codex 5-hour window used per task run (validation runs: 1.5-2%). */
	codexWindowPercentPerTask: [1.5, 2] as const,
	/** List-price estimate per GPT-6.1 Sol attempt (validation mean about $0.15). */
	gptDollarsPerAttempt: [0.07, 0.22] as const,
	/** Gemini 3.8 Flash free tier, measured on the dev key 2026-10-18. */
	geminiRequestsPerMinute: 5,
	/** Model steps per task run (validation: 14-15 steps in 3-4 minutes on GPT). */
	stepsPerTask: [15, 35] as const,
	/** Tokens per task run (validation: 140k-430k input, 2.6k-11k output). */
	inputTokensPerTask: [140_000, 430_000] as const,
	outputTokensPerTask: [2_600, 11_000] as const,
} as const;

/** Wall time, quota and cost for a schedule, as ranges. */
export function roundEstimate(model: string, jobs: readonly TuningJob[]) {
	const route = hardSetRoute(model);
	const own = jobs.filter((job) => job.model === model);
	const taskRuns = sum(own.map((job) => job.tasks.length));
	const parallel = route.kind === "google" ? 1 : 2;
	const wallHours =
		(Math.ceil(own.length / parallel) * ROUND_FACTS.invocationMinutes) / 60;
	const [stepsLow, stepsHigh] = ROUND_FACTS.stepsPerTask;
	const price = (input: number, output: number) =>
		runListPrice({
			...recordPricing(route.recordModel),
			inputTokens: input,
			cachedTokens: Math.round(input * 0.85),
			outputTokens: output,
		}).costUsd;
	const low = price(
		ROUND_FACTS.inputTokensPerTask[0],
		ROUND_FACTS.outputTokensPerTask[0],
	);
	const high = price(
		ROUND_FACTS.inputTokensPerTask[1],
		ROUND_FACTS.outputTokensPerTask[1],
	);
	return {
		invocations: own.length,
		taskRuns,
		wallHours,
		codexWindowPercent:
			route.kind === "codex"
				? ([
						taskRuns * ROUND_FACTS.codexWindowPercentPerTask[0],
						taskRuns * ROUND_FACTS.codexWindowPercentPerTask[1],
					] as const)
				: null,
		requests: [taskRuns * stepsLow, taskRuns * stepsHigh] as const,
		listDollars:
			low === null || high === null
				? null
				: ([taskRuns * low, taskRuns * high] as const),
	};
}
