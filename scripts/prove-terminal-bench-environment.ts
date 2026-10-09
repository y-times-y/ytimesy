import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import {
	createTerminalBenchMachines,
	terminalBenchTaskSchema,
} from "../benchmarks/evaluation/terminal-bench-machines";

const taskPath = resolve(
	process.argv[2] ??
		".ytimesy/terminal-bench-pilot/tasks/terminal-bench/session-window-debug",
);
const config = JSON.parse(
	execFileSync(
		".ytimesy/evaluation-venv/bin/python",
		[
			"-c",
			"import json,tomllib,sys; print(json.dumps(tomllib.load(open(sys.argv[1], 'rb'))))",
			`${taskPath}/task.toml`,
		],
		{ encoding: "utf8" },
	),
);
const instruction = await readFile(`${taskPath}/instruction.md`, "utf8");
let compose: Record<string, unknown>;
try {
	compose = parse(
		await readFile(`${taskPath}/environment/docker-compose.yaml`, "utf8"),
	);
} catch (error) {
	if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	compose = { services: { main: {} } };
}
const services = compose.services as Record<string, Record<string, unknown>>;
services.main.image = config.environment.docker_image;
services.main.command = ["sleep", "infinity"];
const task = terminalBenchTaskSchema.parse({
	id: taskPath.split("/").at(-1),
	instruction,
	image: config.environment.docker_image,
	artifacts: config.artifacts,
	compose,
	resources: {
		cpus: config.environment.cpus,
		memoryMb: config.environment.memory_mb,
		storageMb: config.environment.storage_mb,
	},
	agentTimeoutSeconds: config.agent.timeout_sec,
	verifierMode: config.verifier.environment_mode,
	sourceSha256: createHash("sha256")
		.update(await readFile(`${taskPath}/task.toml`))
		.update(instruction)
		.digest("hex"),
});
const runId = randomUUID();
const output = resolve(
	`.ytimesy/terminal-bench-pilot/environment-proof-${runId}`,
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
	const template = await bridge.prepare(task);
	const child = await bridge.machines.provisionSession(
		`ytimesy-tbench-${randomUUID()}`,
		template.snapshotId,
	);
	await bridge.machines.ensureRunning(child);
	const command = await bridge.machines.exec(
		child,
		"cd /app && git status --porcelain && test ! -e /var/run/docker.sock && printf task-environment-ready",
		15000,
	);
	if (command.exitCode || command.stdout.trim() !== "task-environment-ready")
		throw new Error("Snapshot-backed task environment failed verification.");
	await bridge.exportArtifacts(child, task.artifacts);
	await writeFile(
		`${output}/proof.json`,
		JSON.stringify({
			task: task.id,
			commit: template.commit,
			snapshotRestore: true,
			artifactExport: true,
			inferenceRequests: 0,
		}),
		{ mode: 0o600 },
	);
	console.log(
		"Pinned task environment, snapshot restore and artifact export passed.",
	);
} finally {
	await bridge.cleanup();
	console.log("Owned proof machines and snapshots removed.");
}
