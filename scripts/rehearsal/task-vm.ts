// A hard-set task VM for the rehearsal: the real setup files and setup.sh
// from scripts/hard-set/environment.ts (setupFiles), run as root on a fresh
// rehearsal VM exactly as the live runner starts it. The prepared VM is
// snapshotted under a hash of the VM image and every setup file, so a
// rehearsal reuses it until the setup or the task changes, and each
// scenario boots its own copy of it.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	loadTaskEnvironment,
	setupFiles,
	type TaskEnvironment,
} from "../hard-set/environment";
import { docker, type RehearsalVms, VM_IMAGE } from "./vm";

export const DATASET =
	process.env.YTIMESY_REHEARSAL_DATASET ??
	"/Users/hetpatel/Documents/ChatGPT/cloud/.ytimesy/tb4-dataset";

/** The eval project's folder under ~ (the owner's project is y-times-y/ytimesy). */
export const PROJECT_DIR = "ytimesy";

export type TaskSnapshot = {
	task: TaskEnvironment;
	snapshot: { image: string; volume: string };
	setupLog: string;
	reused: boolean;
};

function imageId(image: string) {
	return execFileSync("docker", ["image", "inspect", "-f", "{{.Id}}", image], {
		encoding: "utf8",
	}).trim();
}

export async function taskSnapshot(
	vms: RehearsalVms,
	taskId: string,
	options: { fresh?: boolean } = {},
): Promise<TaskSnapshot> {
	const task = await loadTaskEnvironment(DATASET, taskId);
	const files = setupFiles(task, PROJECT_DIR);
	const vmImage = (() => {
		try {
			return imageId(VM_IMAGE);
		} catch {
			return "missing";
		}
	})();
	const key = createHash("sha256")
		// format: bump when what a snapshot carries changes (2: ACLs saved).
		.update(JSON.stringify({ vmImage, files, format: 2 }))
		.digest("hex")
		.slice(0, 16);
	const tag = `ytimesy-rehearsal-task:${taskId}-${key}`;
	const volume = tag.replaceAll(/[^a-zA-Z0-9_.-]/g, "-");
	const exists =
		!(await docker(["image", "inspect", tag])).code &&
		!(await docker(["volume", "inspect", volume])).code;
	if (exists && !options.fresh)
		return {
			task,
			snapshot: { image: tag, volume },
			setupLog: "(prepared VM reused: same image, task and setup files)",
			reused: true,
		};
	const name = `${vms.prefix}-setup`;
	const vm = await vms.startEmpty(name);
	const machines = vms.machines();
	// The live runner writes the files through the provider API before setup.
	const made = await vms.root(vm, "mkdir -p /tb && chown ubuntu:ubuntu /tb");
	if (made.code) throw new Error(made.stderr);
	for (const [path, content] of Object.entries(files))
		await machines.writeTextFile(vm, path, content);
	// As scripts/hard-set/vm.ts startDetached: the setup runs as root via sudo.
	const setup = await machines.exec(
		vm,
		"sudo bash /tb/setup.sh > /tmp/rehearsal-setup.log 2>&1; echo $?",
		1_800_000,
	);
	const log =
		(await machines.readTextFile(vm, "/tmp/rehearsal-setup.log")) ?? "";
	if (setup.stdout.trim() !== "0" || !log.includes("setup done"))
		throw new Error(
			`Task setup failed (exit ${setup.stdout.trim()}):\n${log.slice(-3000)}`,
		);
	const setupLog = log
		.split("\n")
		.filter((line) => line.startsWith("[setup"))
		.join("\n");
	await vms.snapshot(vm, tag);
	await vms.destroy(vm);
	vms.created.delete(vm);
	return { task, snapshot: { image: tag, volume }, setupLog, reused: false };
}
