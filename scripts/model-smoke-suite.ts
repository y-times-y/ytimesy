// Development-only per-model smoke suite for the builder harness. Each run gets
// a disposable VM with a tiny fixture repository, one ROOT builder session and
// one turn; a deterministic verifier then runs on the VM. See
// docs/model-smoke-suite.md.
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
	assertDevelopmentDatabase,
	createHarnessRunner,
	emptyRecord,
	percent,
	type RunRecord,
	selectTasks,
	type Task,
	table,
} from "./smoke/builder-harness";

const DEFAULT_MODELS = [
	"codex:gpt-6.1-sol",
	"anthropic/claude-sonnet-5.5",
	"google/gemini-3.8-flash",
	"deepseek/deepseek-v4.1-flash",
];
// Conservative USD per million tokens (input, output); cached input is billed
// at the full input rate so the cap errs high. Override with --price.
const DEFAULT_PRICES: Record<string, [number, number]> = {
	"codex:gpt-6.1-sol": [0, 0],
	"anthropic/claude-sonnet-5.5": [3, 15],
	"google/gemini-3.8-flash": [0.6, 3.5],
	"deepseek/deepseek-v4.1-flash": [0.4, 1.6],
};
const UNKNOWN_PRICE: [number, number] = [5, 25];
// Each run reserves this much worst-case spend before it starts and is
// cancelled if its recorded usage exceeds the reservation.
const RESERVED_TOKENS = { input: 1_000_000, output: 20_000 };

const { values: flags } = parseArgs({
	options: {
		live: { type: "boolean", default: false },
		"max-cost": { type: "string" },
		models: { type: "string" },
		tasks: { type: "string" },
		concurrency: { type: "string", default: "5" },
		"turn-timeout": { type: "string", default: "300" },
		out: { type: "string" },
		price: { type: "string", multiple: true },
	},
});
const maxCost = Number(flags["max-cost"]);
if (!flags.live || !Number.isFinite(maxCost) || maxCost <= 0)
	throw new Error(
		"Refusing to run: pass --live and --max-cost <USD> (a positive spend cap).",
	);
await assertDevelopmentDatabase();
const models = (flags.models?.split(",") ?? DEFAULT_MODELS)
	.map((model) => model.trim())
	.filter(Boolean);
const tasks = selectTasks(flags.tasks);
const concurrency = Math.min(10, Math.max(1, Number(flags.concurrency) || 5));
const turnTimeoutMs =
	Math.min(900, Math.max(30, Number(flags["turn-timeout"]) || 300)) * 1000;
const outPath =
	flags.out ??
	`/tmp/model-smoke-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.json`;
const prices = { ...DEFAULT_PRICES };
for (const entry of flags.price ?? []) {
	const match = /^(.+)=([\d.]+):([\d.]+)$/.exec(entry);
	if (!match) throw new Error("--price expects model=input:output (USD/Mtok).");
	prices[match[1]] = [Number(match[2]), Number(match[3])];
}
const priceOf = (model: string) => prices[model] ?? UNKNOWN_PRICE;
const costOf = (model: string, input: number, output: number) => {
	const [inputPrice, outputPrice] = priceOf(model);
	return (input * inputPrice + output * outputPrice) / 1_000_000;
};
const reservation = (model: string) =>
	costOf(model, RESERVED_TOKENS.input, RESERVED_TOKENS.output);

const runner = await createHarnessRunner({
	models,
	concurrency,
	turnTimeoutMs,
	costOf,
});
let stopping = false;
let committedSpend = 0;
let reservedSpend = 0;
process.on("SIGINT", () => {
	if (stopping) process.exit(130);
	stopping = true;
	runner.stop();
	console.error(
		"Stopping: cancelling runs and cleaning up (Ctrl-C again to force).",
	);
});

async function runOne(model: string, task: Task): Promise<RunRecord> {
	const reserve = reservation(model);
	if (stopping) {
		const record = emptyRecord(model, task.id);
		record.state = "skipped";
		record.errors.push("Suite stopped before this run.");
		return record;
	}
	if (committedSpend + reservedSpend + reserve > maxCost) {
		const record = emptyRecord(model, task.id);
		record.state = "skipped";
		record.errors.push(
			`Cost cap: needs a $${reserve.toFixed(2)} reservation; cap $${maxCost}.`,
		);
		return record;
	}
	reservedSpend += reserve;
	const record = await runner.runOne(model, task, reserve);
	reservedSpend -= reserve;
	committedSpend += record.estimatedCostUsd;
	return record;
}

const startedAt = new Date().toISOString();
const runs: RunRecord[] = [];
try {
	await runner.preflightExecutor();
	const queue = models.flatMap((model) =>
		tasks.map((task) => ({ model, task })),
	);
	console.info(
		`Running ${queue.length} runs (${models.length} models x ${tasks.length} tasks), concurrency ${concurrency}, cap $${maxCost}.`,
	);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
			while (next < queue.length) {
				const { model, task } = queue[next++];
				const record = await runOne(model, task);
				runs.push(record);
				console.info(
					`${record.verifierPassed ? "PASS" : "FAIL"} ${model} ${task.id} ${record.state} ${(record.elapsedMs / 1000).toFixed(0)}s tools=${record.toolCalls} failed=${record.failedToolCalls}`,
				);
			}
		}),
	);
} finally {
	const leaked = await runner.cleanup();
	if (leaked.length) {
		console.error(`Cleanup incomplete: ${leaked.join(", ")}.`);
		process.exitCode = 1;
	}
}

const order = (record: RunRecord) =>
	models.indexOf(record.model) * 100 +
	tasks.findIndex((task) => task.id === record.task);
runs.sort((a, b) => order(a) - order(b));
const summary = models.map((model) => {
	const mine = runs.filter((run) => run.model === model);
	const failedByTool: Record<string, number> = {};
	for (const run of mine)
		for (const [tool, count] of Object.entries(run.failedByTool))
			failedByTool[tool] = (failedByTool[tool] ?? 0) + count;
	const sum = (pick: (run: RunRecord) => number | null) =>
		mine.reduce((total, run) => total + (pick(run) ?? 0), 0);
	const elapsed = mine.map((run) => run.elapsedMs).sort((a, b) => a - b);
	const input = sum((run) => run.inputTokens);
	return {
		model,
		runs: mine.length,
		completed: mine.filter((run) => run.completed).length,
		verified: mine.filter((run) => run.verifierPassed).length,
		medianSeconds: elapsed.length
			? Math.round(elapsed[Math.floor(elapsed.length / 2)] / 1000)
			: null,
		toolCalls: sum((run) => run.toolCalls),
		failedToolCalls: sum((run) => run.failedToolCalls),
		failedByTool,
		modelSteps: sum((run) => run.modelSteps),
		inputTokens: input,
		outputTokens: sum((run) => run.outputTokens),
		cacheHitPercent: percent(
			sum((run) => run.cachedTokens),
			input,
		),
		estimatedCostUsd:
			Math.round(sum((run) => run.estimatedCostUsd) * 1e4) / 1e4,
	};
});
console.info(
	`\n${table([
		[
			"model",
			"task",
			"state",
			"verify",
			"secs",
			"tools",
			"failed",
			"steps",
			"in",
			"out",
			"cache%",
			"usd",
		],
		...runs.map((run) => [
			run.model,
			run.task,
			run.state,
			run.verifierPassed === null ? "-" : run.verifierPassed ? "pass" : "FAIL",
			(run.elapsedMs / 1000).toFixed(0),
			String(run.toolCalls),
			run.failedToolCalls
				? `${run.failedToolCalls} (${Object.entries(run.failedByTool)
						.map(([tool, count]) => `${tool}:${count}`)
						.join(",")})`
				: "0",
			String(run.modelSteps ?? "-"),
			String(run.inputTokens ?? "-"),
			String(run.outputTokens ?? "-"),
			String(run.cacheHitPercent ?? "-"),
			run.estimatedCostUsd.toFixed(3),
		]),
	])}\n\n${table([
		[
			"model",
			"verified",
			"completed",
			"median s",
			"tools",
			"failed",
			"steps",
			"cache%",
			"usd",
		],
		...summary.map((row) => [
			row.model,
			`${row.verified}/${row.runs}`,
			`${row.completed}/${row.runs}`,
			String(row.medianSeconds ?? "-"),
			String(row.toolCalls),
			String(row.failedToolCalls),
			String(row.modelSteps),
			String(row.cacheHitPercent ?? "-"),
			row.estimatedCostUsd.toFixed(3),
		]),
	])}`,
);
for (const run of runs)
	if (run.errors.length)
		console.info(`errors ${run.model} ${run.task}: ${run.errors.join(" | ")}`);
await writeFile(
	outPath,
	`${JSON.stringify(
		{
			startedAt,
			finishedAt: new Date().toISOString(),
			config: {
				models,
				tasks: tasks.map((task) => task.id),
				concurrency,
				turnTimeoutSeconds: turnTimeoutMs / 1000,
				maxCostUsd: maxCost,
				prices: Object.fromEntries(
					models.map((model) => [model, priceOf(model)]),
				),
			},
			summary,
			runs,
		},
		null,
		2,
	)}\n`,
);
console.info(`\nWrote ${outPath}`);
if (runs.some((run) => !run.verifierPassed)) process.exitCode = 1;
