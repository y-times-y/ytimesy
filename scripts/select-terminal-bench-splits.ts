import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { terminalBenchCompose } from "../benchmarks/evaluation/terminal-bench-machines";
import { loadTerminalBenchTask } from "../benchmarks/evaluation/terminal-bench-task";

/**
 * Splits Terminal-Bench into dev / validation / test by a rule fixed before any
 * validation or test task is run, so harness changes cannot be tuned to the
 * tasks that measure them. Dev tasks were already inspected while iterating
 * (two had their hidden tests read), so they never count as held-out evidence.
 *
 * Eligible: loads unchanged in our evaluator, and the public Codex job averaged
 * at most $2.10 and one hour per trial (budget and VM lifetime). Eligible tasks
 * are stratified by Codex's pass count and ranked by a seeded hash.
 */
const SEED = "ytimesy-terminal-bench-4-heldout-2026-10-10";
const DEV = [
	"atrx-vep-crispr",
	"bun-sourcemap-leak",
	"cargo-flight-dispatch",
	"freecad-spring-clip",
	"heat-pump-warranty",
	"interleaved-vigenere",
	"mvcc-lsm-compaction",
	"session-window-debug",
	"shadow-relay",
	"wal-recovery-ordering",
];
const MAX_CODEX_COST_USD = 2.1;
const MAX_CODEX_SECONDS = 3600;
const QUOTAS = {
	always: { validation: 3, test: 6 },
	sometimes: { validation: 1, test: 3 },
	never: { validation: 2, test: 3 },
};

const [tasksRoot] = process.argv.slice(2);
if (!tasksRoot) throw new Error("Specify the Terminal-Bench tasks directory.");
const codex = JSON.parse(
	await readFile("benchmarks/evaluation/codex-public-job.json", "utf8"),
) as {
	tasks: Record<
		string,
		{ passes: number; trials: number; meanCostUsd: number; meanSeconds: number }
	>;
};
const excluded: Record<string, string> = {};
const strata: Record<keyof typeof QUOTAS, string[]> = {
	always: [],
	sometimes: [],
	never: [],
};
for (const id of (await readdir(tasksRoot)).sort()) {
	const result = codex.tasks[id];
	if (DEV.includes(id)) excluded[id] = "dev";
	else if (!result) excluded[id] = "no public Codex result";
	else if (result.meanCostUsd > MAX_CODEX_COST_USD)
		excluded[id] = "Codex trial cost";
	else if (result.meanSeconds > MAX_CODEX_SECONDS)
		excluded[id] = "Codex trial duration";
	else {
		try {
			terminalBenchCompose(
				(await loadTerminalBenchTask(resolve(tasksRoot, id))).task,
			);
		} catch {
			excluded[id] = "unsupported by evaluator";
			continue;
		}
		strata[
			result.passes === result.trials
				? "always"
				: result.passes === 0
					? "never"
					: "sometimes"
		].push(id);
	}
}
const rank = (id: string) =>
	createHash("sha256").update(`${SEED}:${id}`).digest("hex");
const validation: string[] = [];
const test: string[] = [];
const reserve: string[] = [];
for (const [stratum, ids] of Object.entries(strata)) {
	const quota = QUOTAS[stratum as keyof typeof QUOTAS];
	const ordered = [...ids].sort((a, b) => rank(a).localeCompare(rank(b)));
	if (ordered.length < quota.validation + quota.test)
		throw new Error(`Too few eligible ${stratum} tasks.`);
	test.push(...ordered.slice(0, quota.test));
	validation.push(...ordered.slice(quota.test, quota.test + quota.validation));
	reserve.push(...ordered.slice(quota.test + quota.validation));
}
await writeFile(
	"benchmarks/evaluation/terminal-bench-splits.json",
	`${JSON.stringify(
		{
			seed: SEED,
			rule: { MAX_CODEX_COST_USD, MAX_CODEX_SECONDS, QUOTAS },
			dev: DEV,
			validation: validation.sort(),
			test: test.sort(),
			reserve: reserve.sort(),
			excluded,
		},
		null,
		"\t",
	)}\n`,
);
console.log({ validation, test, reserve });
