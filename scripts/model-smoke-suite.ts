// Development-only per-model smoke suite for the builder harness. Each run gets
// a disposable VM with a tiny fixture repository, one ROOT builder session and
// one turn; a deterministic verifier then runs on the VM. See
// docs/model-smoke-suite.md.
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
	harnessVariantFromFlags,
	harnessVariantLabel,
} from "../src/domain/harness-variant";
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
import { createEvalUser, onEvalStop } from "./smoke/eval-user";

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
// `--models free` (development only): OpenRouter's $0 `:free` variants with
// tool calling (tools + tool_choice auto), one per family. Checked against
// openrouter.ai/api/v1/models on 2026-10-16; free variants come and go.
const FREE_MODELS = [
	"google/gemma-4-31b-it:free",
	"nvidia/nemotron-3.5-super-vl:free",
	"cohere/north-mini-code:free",
	"dots-studio/dots-3-note-preview:free",
	"poolside/laguna-s-2.1:free",
];
const isFree = (model: string) => model.endsWith(":free");
// OpenRouter caps `:free` requests at 20/min per account and 50/day (1,000/day
// once 10+ credits were ever bought). Builder steps run back to back, so free
// runs go one at a time (at most 2) and the daily allowance is checked first
// against this per-run planning estimate (model steps plus memory hooks).
const FREE_CONCURRENCY_LIMIT = 2;
const FREE_REQUESTS_PER_RUN = 40;
// Each run reserves this much worst-case spend before it starts and is
// cancelled if its recorded usage exceeds the reservation.
const RESERVED_TOKENS = { input: 1_000_000, output: 20_000 };

const { values: flags } = parseArgs({
	options: {
		live: { type: "boolean", default: false },
		"max-cost": { type: "string" },
		models: { type: "string" },
		tasks: { type: "string" },
		concurrency: { type: "string" },
		"turn-timeout": { type: "string", default: "300" },
		out: { type: "string" },
		price: { type: "string", multiple: true },
		/** Harness variant, e.g. toolSurface=current or memoryWording=notes (repeatable; the default is lean-pi, rules, observer). */
		variant: { type: "string", multiple: true },
		/** Run as the dev owner instead of a throwaway eval user. */
		"as-owner": { type: "boolean", default: false },
		/** The eval user's memory mode (default off). */
		memory: { type: "string", default: "off" },
	},
});
const variant = harnessVariantFromFlags(flags.variant);
if (!["off", "spec", "full"].includes(flags.memory as string))
	throw new Error("--memory accepts off, spec or full.");
const maxCost = Number(flags["max-cost"]);
if (!flags.live || !Number.isFinite(maxCost) || maxCost < 0)
	throw new Error(
		"Refusing to run: pass --live and --max-cost <USD> (a spend cap; 0 only when every model is free).",
	);
await assertDevelopmentDatabase();
const models = [
	...new Set(
		(flags.models?.split(",") ?? DEFAULT_MODELS)
			.map((model) => model.trim())
			.flatMap((model) => (model === "free" ? FREE_MODELS : [model]))
			.filter(Boolean),
	),
];
const tasks = selectTasks(flags.tasks);
const freeRuns = models.filter(isFree).length * tasks.length;
const concurrency = freeRuns
	? Math.min(
			FREE_CONCURRENCY_LIMIT,
			Math.max(1, Number(flags.concurrency) || 1),
		)
	: Math.min(10, Math.max(1, Number(flags.concurrency) || 5));
// The local catalog check offers `:free` routes only behind the dev flag; the
// development edge executor must be deployed with it too.
if (freeRuns) process.env.YTIMESY_DEV_ALLOW_ANY_MODEL ||= "1";
const turnTimeoutMs =
	Math.min(900, Math.max(30, Number(flags["turn-timeout"]) || 300)) * 1000;
const outPath =
	flags.out ??
	`/tmp/model-smoke-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${process.pid}.json`;
const prices = { ...DEFAULT_PRICES };
for (const entry of flags.price ?? []) {
	const match = /^(.+)=([\d.]+):([\d.]+)$/.exec(entry);
	if (!match) throw new Error("--price expects model=input:output (USD/Mtok).");
	prices[match[1]] = [Number(match[2]), Number(match[3])];
}
const priceOf = (model: string): [number, number] =>
	prices[model] ?? (isFree(model) ? [0, 0] : UNKNOWN_PRICE);
if (maxCost === 0 && models.some((model) => priceOf(model).some(Boolean)))
	throw new Error(
		"Refusing to run: --max-cost 0 needs every model to be free.",
	);
const costOf = (model: string, input: number, output: number) => {
	const [inputPrice, outputPrice] = priceOf(model);
	return (input * inputPrice + output * outputPrice) / 1_000_000;
};
const reservation = (model: string) =>
	costOf(model, RESERVED_TOKENS.input, RESERVED_TOKENS.output);

const user = await createEvalUser({
	label: `model-smoke ${harnessVariantLabel(variant)}`,
	variant,
	asOwner: flags["as-owner"],
	openRouter: models.some((model) => !model.startsWith("codex:")),
	memory: flags.memory as "off" | "spec" | "full",
});
console.info(
	`Running as ${user.asOwner ? "the owner" : `eval user ${user.userId}`} (variant ${harnessVariantLabel(variant)}).`,
);
const runner = await createHarnessRunner({
	user,
	models,
	concurrency,
	turnTimeoutMs,
	costOf,
}).catch(async (error) => {
	await user.release();
	throw error;
});
let stopping = false;
let committedSpend = 0;
let reservedSpend = 0;
onEvalStop(() => {
	stopping = true;
	runner.stop();
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
	const paidOpenRouter = models.filter(
		(model) => !model.startsWith("codex:") && !isFree(model),
	);
	if (paidOpenRouter.length) {
		const key = await runner.openRouterKeyStatus();
		const planned = paidOpenRouter.length * tasks.length;
		const left = [key?.limitRemaining, key?.accountCredit].filter(
			(value): value is number => typeof value === "number",
		);
		const available = left.length ? Math.min(...left) : null;
		console.info(
			`OpenRouter: ${key?.accountCredit != null ? `$${key.accountCredit.toFixed(2)} account credit left` : "account credit not reported"}${key?.limitRemaining != null ? `, $${key.limitRemaining.toFixed(2)} under the key's limit` : ""}; ${planned} paid runs, cap $${maxCost}.`,
		);
		if (available !== null && available < Math.min(maxCost, 0.05 * planned))
			throw new Error(
				`Refusing to run: $${available.toFixed(2)} of OpenRouter credit left for ${planned} paid runs. Use free models (--models free) or add credit.`,
			);
		if (available !== null && maxCost > available)
			console.warn(
				`--max-cost $${maxCost} is above the $${available.toFixed(2)} left; OpenRouter will refuse requests once it runs out.`,
			);
	}
	if (freeRuns) {
		const quota = await runner.openRouterFreeQuota();
		const needed = freeRuns * FREE_REQUESTS_PER_RUN;
		if (!quota)
			console.warn(
				`OpenRouter did not report a free-request allowance; ${freeRuns} free runs may need ~${needed} requests.`,
			);
		else {
			console.info(
				`OpenRouter free requests today: ${quota.used}/${quota.limit} used; ${freeRuns} free runs plan for ~${needed}.`,
			);
			if (quota.remaining < needed)
				throw new Error(
					`Refusing to run: ${quota.remaining} free requests remain today (UTC) but ${freeRuns} free runs plan for ~${needed}. Narrow --models/--tasks.`,
				);
		}
	}
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
				variant: harnessVariantLabel(variant),
				evalUser: user.asOwner ? "owner" : user.userId,
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
