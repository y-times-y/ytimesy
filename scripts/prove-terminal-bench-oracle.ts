import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createTerminalBenchMachines } from "../benchmarks/evaluation/terminal-bench-machines";
import { loadTerminalBenchTask } from "../benchmarks/evaluation/terminal-bench-task";
import { gradeTerminalBenchArtifact } from "../benchmarks/evaluation/terminal-bench-verifier";
import { WorkspaceId } from "../src/domain/ids";

// Proves the evaluator's environment, artifact export and separate grading by
// running a task's reference solution with no model. Use only on tasks that
// are never evaluated (dev or excluded); the output is not shown to a model.
const [taskPath, outputPath] = process.argv.slice(2);
if (!taskPath || !outputPath)
	throw new Error("Specify the task and a private output directory.");
const output = resolve(outputPath);
if (!output.startsWith(`${resolve(".ytimesy")}/`))
	throw new Error("Proof output must remain private.");
const key = process.env.FREESTYLE_API_KEY;
if (!key) throw new Error("Missing disposable compute connection.");
await mkdir(output, { recursive: true, mode: 0o700 });
const { task } = await loadTerminalBenchTask(resolve(taskPath));
const bridge = createTerminalBenchMachines({
	apiKey: key,
	runId: randomUUID(),
	maxVms: 1,
	onResources: (resources) =>
		writeFile(`${output}/resources.json`, JSON.stringify(resources), {
			mode: 0o600,
		}),
});
try {
	const prepared = await bridge.prepare(task);
	await bridge.machines.ensureRunning(prepared.vmId);
	const archive = `${output}/solution.tar.gz`;
	execFileSync("tar", ["-czf", archive, "-C", `${taskPath}/solution`, "."]);
	await bridge.uploadArchive(
		prepared.vmId,
		await readFile(archive),
		"/solution",
	);
	const solved = await bridge.machines.exec(
		WorkspaceId(prepared.vmId),
		"bash /solution/solve.sh",
		1_800_000,
	);
	console.log(`${task.id}: reference solution exited ${solved.exitCode}.`);
	const artifacts = await bridge.exportArtifacts(
		prepared.vmId,
		task.artifacts,
		task.collectCommands,
	);
	await writeFile(`${output}/artifacts.tar.gz`, artifacts, { mode: 0o600 });
	await mkdir(`${output}/grade`, { mode: 0o700 });
	const reward = await gradeTerminalBenchArtifact({
		apiKey: key,
		runId: randomUUID(),
		taskPath: resolve(taskPath),
		output: `${output}/grade`,
		artifacts,
	});
	console.log(`${task.id}: cwd ${prepared.cwd}, oracle reward ${reward}.`);
} finally {
	await bridge.cleanup();
}
