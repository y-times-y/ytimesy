import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createTerminalBenchMachines } from "./terminal-bench-machines";
import { loadTerminalBenchTask } from "./terminal-bench-task";

/** Executes the original hidden tests on a separate native-Linux machine,
 * without subscription credentials or any connection to an agent's machine. */
export async function gradeTerminalBenchArtifact(input: {
	apiKey: string;
	runId: string;
	taskPath: string;
	output: string;
	artifacts: Uint8Array;
	signal?: AbortSignal;
}) {
	const { task, verifierImage, verifierTimeoutSeconds } =
		await loadTerminalBenchTask(input.taskPath);
	if (
		!Number.isInteger(verifierTimeoutSeconds) ||
		verifierTimeoutSeconds < 1 ||
		verifierTimeoutSeconds > 1800
	)
		throw new Error("Unsupported original verifier timeout.");
	const bridge = createTerminalBenchMachines({
		apiKey: input.apiKey,
		runId: input.runId,
		maxVms: 1,
		onResources: (resources) =>
			writeFile(`${input.output}/resources.json`, JSON.stringify(resources), {
				mode: 0o600,
			}),
	});
	try {
		input.signal?.throwIfAborted();
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
		input.signal?.throwIfAborted();
		await bridge.restoreArtifacts(grader.vmId, input.artifacts, task.artifacts);
		const testsArchive = `${input.output}/tests.tar.gz`;
		execFileSync("tar", [
			"-czf",
			testsArchive,
			"-C",
			`${input.taskPath}/tests`,
			".",
		]);
		await bridge.uploadArchive(
			grader.vmId,
			await readFile(testsArchive),
			"/tests",
		);
		input.signal?.throwIfAborted();
		const result = await bridge.machines.exec(
			grader.vmId,
			"mkdir -p /logs/verifier && bash /tests/test.sh",
			verifierTimeoutSeconds * 1000,
		);
		await writeFile(
			`${input.output}/verifier-execution.json`,
			JSON.stringify(result),
			{ mode: 0o600 },
		);
		const raw = await bridge.machines.readTextFile(
			grader.vmId,
			"/logs/verifier/reward.txt",
		);
		if (!raw || !["0", "1", "0.0", "1.0"].includes(raw.trim()))
			throw new Error("Official verifier did not produce a valid reward.");
		const reward = Number(raw.trim());
		await writeFile(
			`${input.output}/result.json`,
			JSON.stringify({
				reward,
				verifierExitCode: result.exitCode,
				nativeLinux: true,
				unmodifiedTests: true,
				inferenceRequests: 0,
			}),
			{ mode: 0o600 },
		);
		return reward;
	} finally {
		await bridge.cleanup();
		await writeFile(
			`${input.output}/cleanup.json`,
			JSON.stringify({ ownedResourcesRemoved: true }),
			{ mode: 0o600 },
		);
	}
}
