import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import { terminalBenchTaskSchema } from "./terminal-bench-machines";

/** Reads only public task instructions and environment metadata, never solutions or graders. */
export async function loadTerminalBenchTask(taskPath: string) {
	const bytes = await readFile(`${taskPath}/task.toml`);
	const config = JSON.parse(
		execFileSync(
			resolve(
				process.env.YTIMESY_EVALUATION_SUPPORT_ROOT ?? ".",
				".ytimesy/evaluation-venv/bin/python",
			),
			[
				"-c",
				"import json,tomllib,sys; from harbor.models.task.task import strip_canary; c=tomllib.load(open(sys.argv[1], 'rb')); c['instruction']=strip_canary(open(sys.argv[2]).read()); print(json.dumps(c))",
				`${taskPath}/task.toml`,
				`${taskPath}/instruction.md`,
			],
			{ encoding: "utf8" },
		),
	);
	const instruction = config.instruction as string;
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
			.update(bytes)
			.update(instruction)
			.update(JSON.stringify(compose))
			.digest("hex"),
	});
	return {
		task,
		verifierTimeoutSeconds: config.verifier.timeout_sec as number,
		verifierImage: config.verifier.environment.docker_image as string,
	};
}
