import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createTerminalBenchMachines } from "../benchmarks/evaluation/terminal-bench-machines";
import { loadTerminalBenchTask } from "../benchmarks/evaluation/terminal-bench-task";

// Zero inference: keep official oracle and hidden verifier away from all model processes.
const taskPath = resolve(
	".ytimesy/terminal-bench-pilot/tasks/terminal-bench/nextjs-performance",
);
const { task, verifierImage } = await loadTerminalBenchTask(taskPath);
const runId = randomUUID();
const output = resolve(
	`.ytimesy/terminal-bench-pilot/remote-verifier-proof-${runId}`,
);
await mkdir(output, { recursive: true, mode: 0o700 });
const bridge = createTerminalBenchMachines({
	apiKey: process.env.FREESTYLE_API_KEY ?? "",
	runId,
	maxVms: 2,
	onResources: (resources) =>
		writeFile(`${output}/resources.json`, JSON.stringify(resources), {
			mode: 0o600,
		}),
});
try {
	const source = await bridge.prepare(task);
	await bridge.machines.ensureRunning(source.vmId);
	const solutionArchive = `${output}/oracle.tar.gz`;
	execFileSync("tar", [
		"-czf",
		solutionArchive,
		"-C",
		`${taskPath}/solution`,
		".",
	]);
	await bridge.uploadArchive(
		source.vmId,
		await readFile(solutionArchive),
		"/solution",
	);
	const solved = await bridge.machines.exec(
		source.vmId,
		"bash /solution/solve.sh",
		290000,
	);
	await writeFile(`${output}/oracle-execution.json`, JSON.stringify(solved), {
		mode: 0o600,
	});
	if (solved.exitCode)
		throw new Error("Remote official oracle execution failed.");
	const artifacts = await bridge.exportArtifacts(source.vmId, task.artifacts);
	const grader = await bridge.prepare({
		...task,
		image: verifierImage,
		compose: {
			services: {
				main: { image: verifierImage, command: ["sleep", "infinity"] },
			},
		},
	});
	await bridge.machines.ensureRunning(grader.vmId);
	// The artifact archive has app/ prefixes; strip them for the /app destination.
	const archiveFile = `${output}/artifacts.tar.gz`;
	await writeFile(archiveFile, artifacts, { mode: 0o600 });
	const tarCode =
		"import io,sys,tarfile; a=tarfile.open(sys.argv[1]); o=tarfile.open(sys.argv[2],'w:gz'); [(setattr(m,'name',m.name.removeprefix('app/')),o.addfile(m,a.extractfile(m) if m.isfile() else None)) for m in a.getmembers() if m.name!='app/']; o.close()";
	const stripped = `${output}/app-artifacts.tar.gz`;
	execFileSync(".ytimesy/evaluation-venv/bin/python", [
		"-c",
		tarCode,
		archiveFile,
		stripped,
	]);
	await bridge.uploadArchive(grader.vmId, await readFile(stripped), "/app");
	const testsArchive = `${output}/tests.tar.gz`;
	execFileSync("tar", ["-czf", testsArchive, "-C", `${taskPath}/tests`, "."]);
	await bridge.uploadArchive(
		grader.vmId,
		await readFile(testsArchive),
		"/tests",
	);
	const result = await bridge.machines.exec(
		grader.vmId,
		"mkdir -p /logs/verifier && bash /tests/test.sh",
		290000,
	);
	await writeFile(`${output}/verifier-execution.json`, JSON.stringify(result), {
		mode: 0o600,
	});
	const reward = await bridge.machines.readTextFile(
		grader.vmId,
		"/logs/verifier/reward.txt",
	);
	await writeFile(
		`${output}/result.json`,
		JSON.stringify({
			reward,
			verifierExitCode: result.exitCode,
			inferenceRequests: 0,
			task: task.id,
			nativeLinux: true,
		}),
		{ mode: 0o600 },
	);
	if (reward?.trim() !== "1")
		throw new Error(
			"Official oracle did not pass on the native Linux verifier.",
		);
	console.log(
		"Official Next.js oracle passed the unmodified verifier on native Linux.",
	);
} finally {
	await bridge.cleanup();
	console.log("Owned remote verifier resources removed.");
}
