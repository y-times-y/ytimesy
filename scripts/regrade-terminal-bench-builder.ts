import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gradeTerminalBenchArtifact } from "../benchmarks/evaluation/terminal-bench-verifier";
import { evaluationTokenUsage } from "../benchmarks/evaluation/token-usage";
import type { ApiAgentEvent } from "../src/domain/api-agent-event";

// Grades a finished builder trial whose official grade was lost to provider
// capacity errors. Uses the saved artifact only: no inference is repeated.
const [taskPath, trialPath] = process.argv.slice(2);
if (!taskPath || !trialPath)
	throw new Error("Specify the original task and the private trial output.");
const trial = resolve(trialPath);
if (!trial.startsWith(`${resolve(".ytimesy")}/`))
	throw new Error("Trial output must remain private.");
const key = process.env.FREESTYLE_API_KEY;
if (!key) throw new Error("Missing disposable compute connection.");
const log = await readFile(`${trial}.log`, "utf8");
const stopped = log.match(/builder stopped after ([\d.]+)s \/ (\d+) requests/);
if (!stopped) throw new Error("The builder did not finish in this trial.");
const { events } = JSON.parse(
	await readFile(`${trial}/trace.json`, "utf8"),
) as {
	events: ApiAgentEvent[];
};
const reward = await gradeTerminalBenchArtifact({
	apiKey: key,
	runId: randomUUID(),
	taskPath: resolve(taskPath),
	output: `${trial}/official-grade`,
	artifacts: await readFile(`${trial}/artifacts.tar.gz`),
});
await writeFile(
	`${trial}/result.json`,
	JSON.stringify(
		{
			reward,
			failure: null,
			requests: Number(stopped[2]),
			agentSeconds: Number(stopped[1]),
			noLeader: true,
			regraded: true,
			...evaluationTokenUsage(events),
			usageAccounting: "cumulative usage including compaction",
		},
		null,
		2,
	),
	{ mode: 0o600 },
);
console.log(`${trial}: official reward ${reward} (regraded).`);
