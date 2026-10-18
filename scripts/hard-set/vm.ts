// Development VMs for task environments, shared by the hard-set runner
// (scripts/hard-set.ts) and the checker detection test
// (scripts/checker-detect.ts): workspace-image VMs resized to a task, root
// scripts run detached with their output in /tb, directory uploads, and the
// development edge's executor preflight and Codex usage read.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Freestyle } from "freestyle";
import { signDeliveryRequest } from "../../src/domain/delivery-auth";
import { WorkspaceId } from "../../src/domain/ids";
import { subscriptionFetch } from "../../src/server/adapters/codex-subscription-transport";
import { GUEST_INTERNET_FIREWALL } from "../../src/server/adapters/freestyle/proof-vm";
import { waitUntilVmRunning } from "../../src/server/adapters/freestyle/wait-until-running";
import { createFreestyleWorkspaceMachines } from "../../src/server/adapters/freestyle/workspace-machines";
import { modelWorkflowSigningSecret } from "../../src/server/adapters/model-workflow-dispatch";
import { workspaceBootSnapshotId } from "../../src/server/records/tools-snapshot-store";
import { DEVELOPMENT_EDGE_ORIGIN } from "../development-config";
import { safe } from "../smoke/builder-harness";

export const sh = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export type TaskVms = ReturnType<typeof taskVms>;

export function taskVms(apiKey: string) {
	const client = new Freestyle({ apiKey });
	const machines = createFreestyleWorkspaceMachines(apiKey);

	async function execOk(vm: string, command: string, ms: number) {
		const result = await machines.exec(WorkspaceId(vm), command, ms);
		if (result.exitCode)
			throw new Error(
				`VM command failed (${result.exitCode}): ${`${result.stdout}${result.stderr}`.slice(-800)}`,
			);
		return result.stdout;
	}

	/** Starts a root script on the VM, detached; output and exit code land in /tb/<name>.log/.exit. */
	async function startDetached(vm: string, script: string, name: string) {
		await machines.writeTextFile(WorkspaceId(vm), `/tb/${name}.sh`, script);
		await execOk(
			vm,
			`sudo rm -f /tb/${name}.exit /tb/${name}.log; sudo nohup setsid bash -c 'bash /tb/${name}.sh > /tb/${name}.log 2>&1; echo $? > /tb/${name}.exit' >/dev/null 2>&1 &`,
			20_000,
		);
	}

	/** Waits for a detached script until `until`; null while it is still running. */
	async function waitDetached(vm: string, name: string, until: number) {
		while (true) {
			const done = await machines
				.exec(WorkspaceId(vm), `cat /tb/${name}.exit 2>/dev/null`, 15_000)
				.catch(() => null);
			if (done?.stdout.trim()) {
				const log = (
					await machines.exec(WorkspaceId(vm), `cat /tb/${name}.log`, 15_000)
				).stdout;
				return { exit: Number(done.stdout.trim()), log };
			}
			if (Date.now() > until) return null;
			await delay(3000);
		}
	}

	async function runDetached(
		vm: string,
		script: string,
		name: string,
		timeoutSec: number,
	) {
		await startDetached(vm, script, name);
		return (
			(await waitDetached(vm, name, Date.now() + timeoutSec * 1000)) ?? {
				exit: 124,
				log: `${
					(
						await machines
							.exec(WorkspaceId(vm), `tail -c 2000 /tb/${name}.log`, 15_000)
							.catch(() => ({ stdout: "" }))
					).stdout
				}\n(timed out after ${Math.round(timeoutSec)}s)`,
			}
		);
	}

	/** Uploads a local file to the VM. */
	async function uploadFile(vm: string, local: string, remote: string) {
		await client.vms
			.ref(vm)
			.fs.writeFile(remote, new Uint8Array(await readFile(local)));
	}

	/** Uploads a local directory to the VM as <remote>.tgz, unpacked at `remote`. */
	async function uploadDirectory(vm: string, local: string, remote: string) {
		const scratch = await mkdtemp(join(tmpdir(), "hard-set-"));
		try {
			const archive = join(scratch, "upload.tgz");
			execFileSync("tar", ["-czf", archive, "-C", local, "."]);
			await uploadFile(vm, archive, `${remote}.tgz`);
			await execOk(
				vm,
				`sudo rm -rf ${sh(remote)} && sudo mkdir -p ${sh(remote)} && sudo tar -xzf ${sh(`${remote}.tgz`)} -C ${sh(remote)}`,
				120_000,
			);
		} finally {
			await rm(scratch, { recursive: true, force: true });
		}
	}

	/** A VM from the workspace image, resized; Freestyle caps a VM at 8 vCPUs. */
	async function createVm(
		slug: string,
		purpose: string,
		cpus: number,
		memoryMb: number,
		lifetimeSec: number,
		onCreated: (vmId: string) => void,
	) {
		const created = await client.vms.create({
			slug,
			snapshotId: await workspaceBootSnapshotId(),
			firewall: GUEST_INTERNET_FIREWALL,
			ttlSeconds: lifetimeSec + 300,
			maxRunTotalSeconds: lifetimeSec,
			// Tests run for minutes with nobody polling (a grader outlives its
			// invocation); an idle stop would kill them, so idling never stops it.
			idleTimeoutSeconds: lifetimeSec,
			automaticRestart: false,
			metadata: { purpose },
		} as never);
		onCreated(created.vmId);
		const data = await waitUntilVmRunning(created.vm, "Hard set");
		// At least the task's own size, and 4 vCPUs so builds and tests fit the
		// invocation; memory for the workspace itself; disk for the images.
		const target = {
			cpu: Math.min(8, Math.max(4, cpus)),
			memory: Math.min(16384, Math.max(4096, memoryMb + 2048)),
			storage: Math.max(data.resources.storage, 32768),
		};
		await created.vm.resize(target);
		// Resized CPUs come online a few seconds after the resize.
		for (let attempt = 0; attempt < 15; attempt++) {
			const online = await machines
				.exec(WorkspaceId(created.vmId), "nproc", 15_000)
				.catch(() => null);
			if (Number(online?.stdout.trim()) >= target.cpu) break;
			await delay(2000);
		}
		await execOk(
			created.vmId,
			"sudo mkdir -p /tb && sudo chown ubuntu:ubuntu /tb",
			30_000,
		);
		return `${target.cpu} cpu / ${target.memory} MB / ${target.storage} MB`;
	}

	return {
		client,
		machines,
		execOk,
		startDetached,
		waitDetached,
		runDetached,
		uploadFile,
		uploadDirectory,
		createVm,
	};
}

/** Waits until the development edge's executor gate is open. */
export async function preflightExecutor() {
	const url = `${DEVELOPMENT_EDGE_ORIGIN}/start`;
	const body = JSON.stringify({ turnId: randomUUID(), leaseId: randomUUID() });
	for (let attempt = 0; attempt < 30; attempt++) {
		const response = await fetch(url, {
			method: "POST",
			body,
			headers: await signDeliveryRequest(
				modelWorkflowSigningSecret(),
				"POST",
				url,
				body,
			),
			signal: AbortSignal.timeout(15_000),
		});
		if (response.status === 409) return;
		if (response.status !== 503)
			throw new Error(`Executor preflight failed (${response.status}).`);
		await delay(2000);
	}
	throw new Error("Executor gate is not open.");
}

/** The subscription's 5-hour and weekly usage, read only (no inference). */
export async function codexUsage(ownerId: string) {
	try {
		const response = await subscriptionFetch(ownerId, "wham/usage");
		if (!response.ok) return `usage unavailable (${response.status})`;
		const body = (await response.json()) as {
			rate_limit?: {
				limit_reached?: boolean;
				primary_window?: { used_percent?: number };
				secondary_window?: { used_percent?: number };
			};
		};
		const limit = body.rate_limit;
		return `5h ${limit?.primary_window?.used_percent ?? "?"}%, week ${limit?.secondary_window?.used_percent ?? "?"}%${limit?.limit_reached ? " (LIMIT REACHED)" : ""}`;
	} catch (error) {
		return `usage unavailable (${safe(error)})`;
	}
}
