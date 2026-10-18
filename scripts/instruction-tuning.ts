// Development-only instruction tuning (docs/instruction-tuning.md): runs the
// hard set (docs/hard-set.md) for each model under each instruction profile
// (harness variant `instructions`, src/domain/instruction-profiles.ts) and
// ranks the profiles per model. Every task runs through scripts/hard-set.ts
// child processes: ≤10 minutes each, ≤2 at a time (Gemini: 1), interleaved
// across profiles. Never report these numbers as Terminal-Bench scores.
//
// node --env-file=.env --import tsx scripts/instruction-tuning.ts --plan --run tune-1 --models gpt-6.1-sol,google/gemini-3.8-flash
// node --env-file=.env --import tsx scripts/instruction-tuning.ts --live --run tune-1 --models gpt-6.1-sol
// node --env-file=.env --import tsx scripts/instruction-tuning.ts --report --run tune-1 --models gpt-6.1-sol
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { HARNESS_VARIANT_VALUES } from "../src/domain/harness-variant";
import type { InstructionProfile } from "../src/domain/instruction-profiles";
import {
	DEFAULT_GEMINI_KEY_FILE,
	probeGeminiQuota,
	readGeminiKey,
} from "./hard-set/gemini";
import type { HardSetRecord } from "./hard-set/records";
import { hardSetRoute } from "./hard-set/route";
import { HARD_SET } from "./hard-set/tasks";
import {
	ROUND_FACTS,
	rankVariants,
	recommendation,
	remainingTasks,
	roundEstimate,
	type TuningJob,
	tuningRunName,
	tuningSchedule,
} from "./instruction-tuning/plan";
import { table } from "./smoke/builder-harness";

const RUNS = resolve(".ytimesy/hard-set");
const PROFILES = HARNESS_VARIANT_VALUES.instructions.filter(
	(value): value is InstructionProfile => value !== "default",
);

const { values: flags } = parseArgs({
	options: {
		live: { type: "boolean", default: false },
		plan: { type: "boolean", default: false },
		report: { type: "boolean", default: false },
		/** Prefix of the hard-set runs: <run>.<model>.<profile>. */
		run: { type: "string" },
		models: { type: "string", default: "gpt-6.1-sol" },
		/** Profiles to compare; baseline is always included. */
		variants: { type: "string", default: PROFILES.join(",") },
		/** Task ids, or a category: hard, time-pressure, control, all. */
		tasks: { type: "string", default: "all" },
		repeats: { type: "string", default: "1" },
		"agent-minutes": { type: "string", default: "7" },
		/** Codex reasoning effort passed to hard-set (model default when unset). */
		reasoning: { type: "string" },
		"google-key-file": { type: "string", default: DEFAULT_GEMINI_KEY_FILE },
		/** Hard-set processes at once (at most 2; Gemini runs one at a time). */
		concurrency: { type: "string", default: "2" },
	},
});

const prefix = flags.run;
if (!prefix || !/^[A-Za-z0-9_=-]{1,40}$/.test(prefix))
	throw new Error("Pass --run <prefix> (letters, digits, _ = -; no dots).");
const models = (flags.models as string).split(",").map((model) => model.trim());
for (const model of models) hardSetRoute(model);
const variants = [
	...new Set([
		"baseline",
		...(flags.variants as string).split(",").map((value) => value.trim()),
	]),
] as InstructionProfile[];
for (const variant of variants)
	if (!PROFILES.includes(variant))
		throw new Error(
			`--variants accepts ${PROFILES.join(", ")}; got ${variant}.`,
		);
const tasks =
	flags.tasks === "all"
		? HARD_SET
		: ["hard", "time-pressure", "control"].includes(flags.tasks as string)
			? HARD_SET.filter((task) => task.category === flags.tasks)
			: (flags.tasks as string).split(",").map((id) => {
					const task = HARD_SET.find((entry) => entry.id === id.trim());
					if (!task) throw new Error(`Unknown hard-set task ${id}.`);
					return task;
				});
const repeats = Number(flags.repeats);
if (!(Number.isInteger(repeats) && repeats >= 1 && repeats <= 10))
	throw new Error("--repeats expects 1..10.");
const processes = Math.min(2, Math.max(1, Number(flags.concurrency) || 2));
const schedule = tuningSchedule({ prefix, models, variants, tasks, repeats });

async function readRun(run: string): Promise<HardSetRecord[]> {
	const dir = join(RUNS, run);
	const files = (await readdir(dir).catch(() => [] as string[])).filter(
		(file) => file.endsWith(".json") && !file.endsWith(".transcript.json"),
	);
	return Promise.all(
		files.map(
			async (file) =>
				JSON.parse(await readFile(join(dir, file), "utf8")) as HardSetRecord,
		),
	);
}

const fixed = (value: number, digits = 2) => value.toFixed(digits);

function printPlan() {
	console.log(
		`Instruction tuning ${prefix}: ${models.join(", ")} × ${variants.join(", ")} × ${tasks.length} task(s) × ${repeats} repeat(s); ${schedule.length} hard-set invocation(s), ${processes} at a time (Gemini 1).`,
	);
	for (const model of models) {
		const estimate = roundEstimate(model, schedule);
		const lines = [
			`${model}: ${estimate.invocations} invocations, ${estimate.taskRuns} task runs, about ${fixed(estimate.wallHours, 1)} h of wall time on its own`,
		];
		if (estimate.codexWindowPercent)
			lines.push(
				`Codex usage ${Math.round(estimate.codexWindowPercent[0])}-${Math.round(estimate.codexWindowPercent[1])}% of one 5-hour window (${fixed(estimate.codexWindowPercent[0] / 100, 1)}-${fixed(estimate.codexWindowPercent[1] / 100, 1)} windows); the runner stops at the limit and resumes on the same --run`,
			);
		else
			lines.push(
				`about ${estimate.requests[0]}-${estimate.requests[1]} Gemini requests at ≤${ROUND_FACTS.geminiRequestsPerMinute}/min (free tier, shared by the project); the daily request quota decides how many fit in a day, and the runner stops at it`,
			);
		if (estimate.listDollars)
			lines.push(
				`$${fixed(estimate.listDollars[0])}-${fixed(estimate.listDollars[1])} of tokens at list price${hardSetRoute(model).kind === "codex" ? " (estimate: the subscription pays)" : " (free tier: not charged)"}, plus about $0.10-0.15 of VMs per task run`,
			);
		console.log(`- ${lines.join("; ")}.`);
	}
}

async function report() {
	for (const model of models) {
		const byVariant = new Map<InstructionProfile, HardSetRecord[]>();
		for (const variant of variants)
			byVariant.set(
				variant,
				await readRun(tuningRunName(prefix as string, model, variant)),
			);
		const ranked = rankVariants(byVariant);
		const all = [...byVariant.values()].flat();
		const grading = all.filter((record) => record.status === "grading").length;
		const limited = all.filter((record) => record.usageLimit).length;
		const commonTasks = (() => {
			const sets = [...byVariant.values()].map(
				(records) =>
					new Set(
						records
							.filter((record) => record.status === "final")
							.map((record) => record.task),
					),
			);
			return sets.length
				? [...sets[0]].filter((task) => sets.every((set) => set.has(task)))
						.length
				: 0;
		})();
		const maxRepeat = Math.max(
			0,
			...all.map((record) => Number(record.attempt) || 0),
		);
		console.log(`\n${model} (${commonTasks} tasks scored by every profile)`);
		console.log(
			table([
				[
					"rank",
					"profile",
					"pass/scored",
					"common rate",
					"hard",
					"time-pr",
					"control",
					"vs base W/L",
					"pass s",
					"tok/solved",
					"cached",
					"~$/solved",
				],
				...ranked.map((row, index) => {
					const category = (name: string) =>
						row.byCategory[name]
							? `${row.byCategory[name].passed}/${row.byCategory[name].scored}`
							: "-";
					return [
						String(index + 1),
						row.variant,
						`${row.passed}/${row.scored}`,
						row.commonRate === null
							? "-"
							: `${Math.round(row.commonRate * 100)}%`,
						category("hard"),
						category("time-pressure"),
						category("control"),
						row.variant === "baseline" ? "-" : `${row.wins}/${row.losses}`,
						row.meanPassSec === null ? "-" : String(row.meanPassSec),
						row.tokensPerSolved === null ? "-" : String(row.tokensPerSolved),
						row.cachedPercent === null ? "-" : `${row.cachedPercent}%`,
						row.costPerSolved === null ? "-" : `$${fixed(row.costPerSolved)}`,
					];
				}),
			]),
		);
		console.log(recommendation(ranked, commonTasks, maxRepeat));
		console.log(
			"Noise: a 1-2 task difference is noise (one task's TB4 trials often split 2/5 or 3/5). Compare on the same tasks, interleaved, and repeat 3+ times before changing INSTRUCTION_PROFILE_BY_FAMILY.",
		);
		if (grading || limited)
			console.log(
				`Not scored yet: ${grading} grading (the runner collects them), ${limited} stopped by a usage limit (rerun the same --run to resume).`,
			);
	}
}

type ChildResult = { code: number | null; geminiQuota: GeminiStop | null };
type GeminiStop = { daily: boolean; retryAfterSec: number | null };

/** One hard-set invocation; its output streams through with a job prefix. */
function runHardSet(args: string[], label: string): Promise<ChildResult> {
	return new Promise((done) => {
		const child = spawn(
			process.execPath,
			["--env-file=.env", "--import", "tsx", "scripts/hard-set.ts", ...args],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		let geminiQuota: GeminiStop | null = null;
		const forward = (chunk: Buffer, stream: NodeJS.WriteStream) => {
			for (const line of chunk.toString().split("\n").filter(Boolean)) {
				const quota = /^GEMINI_QUOTA (.+)$/.exec(line);
				if (quota)
					try {
						geminiQuota = JSON.parse(quota[1]) as GeminiStop;
					} catch {}
				stream.write(`[${label}] ${line}\n`);
			}
		};
		child.stdout.on("data", (chunk: Buffer) => forward(chunk, process.stdout));
		child.stderr.on("data", (chunk: Buffer) => forward(chunk, process.stderr));
		child.on("close", (code) => done({ code, geminiQuota }));
	});
}

async function live() {
	const stopped = new Map<string, string>();
	let interrupted = false;
	process.once("SIGINT", () => {
		interrupted = true;
		console.warn(
			"Stopping after the running invocations (they cancel and clean up their own runs).",
		);
	});
	const googleKey = models.some(
		(model) => hardSetRoute(model).kind === "google",
	)
		? await readGeminiKey(flags["google-key-file"])
		: null;
	const queue: (TuningJob & { requeues: number })[] = schedule.map((job) => ({
		...job,
		requeues: 0,
	}));
	const running = new Set<string>();
	let failuresInRow = 0;

	/** After a Gemini quota stop: wait out a per-minute limit, stop on a daily one. */
	async function geminiQuotaStop(model: string, stop: GeminiStop | null) {
		if (!googleKey) return true;
		const quota = stop
			? { state: "limited" as const, ...stop }
			: await (async () => {
					await delay(65_000);
					return probeGeminiQuota(googleKey, hardSetRoute(model).modelId);
				})();
		if (quota.state === "limited" && quota.daily) {
			stopped.set(model, "Gemini daily quota reached");
			return true;
		}
		if (quota.state === "limited")
			await delay(Math.min(120, (quota.retryAfterSec ?? 60) + 5) * 1000);
		return false;
	}

	async function runJob(job: (typeof queue)[number]) {
		const before = await readRun(job.run);
		const pending = remainingTasks(job, before);
		if (!pending.length) return;
		const label = `${job.model} ${job.variant} r${job.repeat}`;
		const args = [
			"--live",
			"--run",
			job.run,
			"--tasks",
			pending.join(","),
			"--model",
			job.model,
			"--variant",
			`instructions=${job.variant}`,
			"--agent-minutes",
			flags["agent-minutes"] as string,
			"--max-minutes",
			"10",
			...(flags.reasoning && hardSetRoute(job.model).kind === "codex"
				? ["--reasoning", flags.reasoning]
				: []),
			...(hardSetRoute(job.model).kind === "google"
				? [
						"--google-key-file",
						flags["google-key-file"] as string,
						"--concurrency",
						"1",
					]
				: []),
		];
		console.info(`Starting ${label}: ${pending.join(", ")}`);
		const result = await runHardSet(args, label);
		const after = await readRun(job.run);
		const fresh = after.filter(
			(record) =>
				!before.some(
					(old) => old.task === record.task && old.attempt === record.attempt,
				),
		);
		const limit = fresh.find((record) => record.usageLimit)?.usageLimit;
		if (result.code !== 0 && !fresh.length) failuresInRow++;
		else failuresInRow = 0;
		const route = hardSetRoute(job.model).kind;
		if (route === "google" && (limit || result.geminiQuota)) {
			const stop = await geminiQuotaStop(job.model, result.geminiQuota);
			if (!stop && job.requeues < 3)
				queue.push({ ...job, requeues: job.requeues + 1 });
		} else if (limit) stopped.set(job.model, limit);
		if (failuresInRow >= 3) {
			interrupted = true;
			console.error(
				"Three invocations in a row failed without records; stopping.",
			);
		}
	}

	const workers = Array.from({ length: processes }, async () => {
		while (!interrupted) {
			const index = queue.findIndex(
				(job) =>
					!stopped.has(job.model) &&
					!(
						hardSetRoute(job.model).kind === "google" && running.has(job.model)
					),
			);
			if (index < 0) {
				if (!running.size || queue.every((job) => stopped.has(job.model)))
					return;
				await delay(5000);
				continue;
			}
			const [job] = queue.splice(index, 1);
			const key =
				hardSetRoute(job.model).kind === "google"
					? job.model
					: `${job.model}#${Math.random()}`;
			running.add(key);
			try {
				await runJob(job);
			} finally {
				running.delete(key);
			}
		}
	});
	await Promise.all(workers);
	// Tests that outlasted their invocation: collect each run once.
	for (const run of new Set(schedule.map((job) => job.run)))
		if ((await readRun(run)).some((record) => record.status === "grading"))
			await runHardSet(["--collect", "--run", run], `collect ${run}`);
	for (const [model, reason] of stopped)
		console.log(
			`STOPPED ${model}: ${reason}. Rerun the same command later to resume; finished tasks are skipped.`,
		);
}

if (flags.plan || (!flags.live && !flags.report)) printPlan();
if (flags.live) {
	printPlan();
	await live();
}
if (flags.live || flags.report) await report();
if (!flags.live && !flags.report && !flags.plan)
	console.log("\nPass --live to run, --report to rank recorded runs.");
