/**
 * The AA-style efficiency block for Harbor bridge v2 jobs: per job (one arm)
 * the shared eval-efficiency summary (src/domain/eval-efficiency.ts, the
 * block the hard-set runner prints): solved, $/task, $/solved, tokens,
 * calls, cache hit rate and seconds per task, then one line per role and
 * model. Each trial's spend comes from its ytimesy-trace.json `efficiency`
 * block; solved is the verifier's reward = 1 in its result.json.
 *
 * node --import tsx evals/harbor_v2/efficiency.ts <jobs-dir> [job-name ...]
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type EfficiencyRun,
	efficiencySummary,
	formatEfficiencyBlock,
} from "../../src/domain/eval-efficiency";
import { isMainModule } from "./main-module";
import type { TrialEfficiency } from "./trial";

async function json(path: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return null;
	}
}

/** One trial directory's run, or null when it has no bridge trace (oracle, nop, a setup failure). */
export async function trialRun(
	trialDirectory: string,
): Promise<EfficiencyRun | null> {
	const trace = (await json(
		join(trialDirectory, "agent", "ytimesy-trace.json"),
	)) as {
		efficiency?: TrialEfficiency | null;
	} | null;
	if (!trace?.efficiency) return null;
	const result = (await json(join(trialDirectory, "result.json"))) as {
		verifier_result?: { rewards?: Record<string, unknown> } | null;
	} | null;
	return {
		solved: result?.verifier_result?.rewards?.reward === 1,
		seconds: trace.efficiency.secondsPerTask,
		models: trace.efficiency.modelRows,
	};
}

export async function jobRuns(jobDirectory: string) {
	const trials = (await readdir(jobDirectory, { withFileTypes: true })).filter(
		(entry) => entry.isDirectory() && entry.name.includes("__"),
	);
	const runs = await Promise.all(
		trials.map((trial) => trialRun(join(jobDirectory, trial.name))),
	);
	return runs.filter((run): run is EfficiencyRun => run !== null);
}

async function main() {
	const [jobsDir, ...names] = process.argv.slice(2);
	if (!jobsDir)
		throw new Error("Usage: efficiency.ts <jobs-dir> [job-name ...]");
	const jobs = names.length
		? names
		: (await readdir(jobsDir, { withFileTypes: true }))
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name)
				.sort();
	for (const job of jobs) {
		const runs = await jobRuns(join(jobsDir, job));
		if (!runs.length) continue;
		for (const line of formatEfficiencyBlock(job, efficiencySummary(runs)))
			console.log(line);
	}
}

if (isMainModule(import.meta.url, "efficiency")) await main();
