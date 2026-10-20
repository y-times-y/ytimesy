// Rehearsal "VMs": privileged Ubuntu containers in local Docker, each with
// its own dockerd (the hard-set task container runs inside it, as on a
// development workspace VM). WorkspaceMachines over `docker exec` stands in
// for the Freestyle adapter: commands run as `ubuntu` in /home/ubuntu
// through `bash -c` (the user the live VM's exec runs as; the setup itself
// runs as root through sudo, as scripts/hard-set/vm.ts starts it), and a
// fork copies the VM's disk and its Docker state, so the fork's task
// container has the parent's checkout and its installed tools.
//
// Fidelity notes (what a real VM has that this does not):
// - a fork restarts the task container (a Freestyle fork keeps its processes);
// - files written through the provider API are written as `ubuntu`;
// - the image is ubuntu:24.04 with the packages below, not the tools snapshot.
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { WorkspaceId } from "../../src/domain/ids";
import type {
	CommandOutput,
	WorkspaceMachines,
} from "../../src/server/services/workspace-machines";

export const VM_IMAGE = "ytimesy-rehearsal-vm:1";
const LABEL = "ytimesy-rehearsal=1";

const DOCKERFILE = `FROM ubuntu:24.04
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \\
    docker.io docker-compose-v2 sudo acl python3 git tmux iproute2 ripgrep jq curl ca-certificates procps psmisc \\
    >/dev/null && rm -rf /var/lib/apt/lists/*
RUN usermod -aG docker ubuntu && echo 'ubuntu ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/ubuntu \\
 && printf '#!/bin/sh\\nexit 0\\n' > /usr/local/bin/systemctl \\
 && chmod +x /usr/local/bin/systemctl
`;

type Run = { code: number; stdout: string; stderr: string };

/**
 * docker exec into a VM. A fork pauses its source for the snapshot; a call
 * meanwhile waits for it, as a provider call waits out a live snapshot
 * (Freestyle's own behaviour during a fork is not reproduced).
 */
async function vmExec(
	args: string[],
	options: { input?: string; timeoutMs?: number } = {},
): Promise<Run> {
	for (let attempt = 0; ; attempt++) {
		const result = await docker(args, options);
		if (
			!(result.code && /is paused, unpause/.test(result.stderr)) ||
			attempt > 120
		)
			return result;
		await delay(500);
	}
}

/** Async docker CLI call (never blocks the event loop the turns run on). */
export function docker(
	args: string[],
	options: { input?: string; timeoutMs?: number } = {},
): Promise<Run> {
	return new Promise((resolve) => {
		const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout.on("data", (chunk) => out.push(chunk));
		child.stderr.on("data", (chunk) => err.push(chunk));
		let timedOut = false;
		const timer = options.timeoutMs
			? setTimeout(() => {
					timedOut = true;
					child.kill("SIGKILL");
				}, options.timeoutMs)
			: undefined;
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			resolve({
				code: timedOut ? 124 : (code ?? 1),
				stdout: Buffer.concat(out).toString("utf8"),
				stderr: Buffer.concat(err).toString("utf8"),
			});
		});
		child.stdin.on("error", () => {});
		child.stdin.end(options.input ?? "");
	});
}

async function dockerOk(args: string[], timeoutMs = 600_000) {
	const result = await docker(args, { timeoutMs });
	if (result.code)
		throw new Error(
			`docker ${args.slice(0, 3).join(" ")} failed (${result.code}): ${(result.stderr || result.stdout).slice(-800)}`,
		);
	return result.stdout.trim();
}

export function ensureVmImage() {
	try {
		execFileSync("docker", ["image", "inspect", VM_IMAGE], { stdio: "ignore" });
		return;
	} catch {}
	execFileSync("docker", ["build", "-q", "-t", VM_IMAGE, "-"], {
		input: DOCKERFILE,
		stdio: ["pipe", "ignore", "inherit"],
	});
}

export class RehearsalVms {
	readonly created = new Set<string>();
	/** Every exec, for assertions: vm, user-visible command, exit code. */
	readonly log: {
		vm: string;
		command: string;
		exitCode: number;
		ms: number;
	}[] = [];
	private forkCount = 0;
	constructor(readonly prefix: string) {}

	/** Starts a VM from the image and an empty Docker state. */
	async startEmpty(name: string) {
		ensureVmImage();
		await this.remove(name);
		await dockerOk(["volume", "create", "--label", LABEL, `${name}-docker`]);
		await this.boot(name, VM_IMAGE);
		this.created.add(name);
		return WorkspaceId(name);
	}

	/** Starts a VM from a snapshot (disk image plus Docker state volume). */
	async startFrom(snapshot: { image: string; volume: string }, name: string) {
		await this.remove(name);
		await dockerOk(["volume", "create", "--label", LABEL, `${name}-docker`]);
		await copyVolume(snapshot.volume, `${name}-docker`);
		await this.boot(name, snapshot.image);
		this.created.add(name);
		// docker commit drops ACLs and gives every file a new ctime; a VM (and
		// a Freestyle fork) keeps both. Restore the ACLs the setup made and
		// refresh the checkout's index, so git sees the tree as the setup left it.
		const restored = await this.root(
			name,
			`if [ -f /tb/.rehearsal-acls ]; then cd / && setfacl --restore=/tb/.rehearsal-acls; fi
if [ -f /tb/workdir ]; then sudo -u ubuntu git -C "$(cat /tb/workdir)" update-index -q --refresh >/dev/null || true; fi`,
		);
		if (restored.code)
			throw new Error(`${name}: ACL restore failed: ${restored.stderr}`);
		await this.restartTaskContainer(name);
		return WorkspaceId(name);
	}

	private async restartTaskContainer(name: string) {
		const restarted = await docker(
			[
				"exec",
				name,
				"sh",
				"-c",
				"if docker inspect tb >/dev/null 2>&1; then docker start tb >/dev/null; fi; echo ok",
			],
			{ timeoutMs: 120_000 },
		);
		if (restarted.code)
			throw new Error(
				`${name}: task container restart failed: ${restarted.stderr}`,
			);
	}

	private async remove(name: string) {
		await docker(["rm", "-f", name]);
		await docker(["volume", "rm", "-f", `${name}-docker`]);
	}

	private async boot(name: string, image: string) {
		await dockerOk([
			"run",
			"-d",
			"--privileged",
			"--label",
			LABEL,
			"--name",
			name,
			"--hostname",
			name,
			"-v",
			`${name}-docker:/var/lib/docker`,
			image,
			"bash",
			"-c",
			// A snapshot carries the source's pid files and sockets; a fresh boot has none.
			"rm -rf /var/run/docker.pid /var/run/docker.sock /var/run/docker; dockerd >/var/log/dockerd.log 2>&1 & sleep infinity",
		]);
		for (let attempt = 0; attempt < 120; attempt++) {
			const ready = await docker(["exec", name, "docker", "info"], {
				timeoutMs: 10_000,
			});
			if (!ready.code) return;
			await delay(500);
		}
		throw new Error(`${name}: dockerd did not start.`);
	}

	/**
	 * Snapshots a VM (disk and Docker state, taken while it is paused) as
	 * image `tag` and volume `tag` with dashes; reused by startFrom.
	 */
	async snapshot(name: string, tag: string) {
		const volume = tag.replaceAll(/[^a-zA-Z0-9_.-]/g, "-");
		const saved = await this.root(
			name,
			"if [ -f /tb/route-mounts ]; then getfacl -R -p $(cat /tb/route-mounts) > /tb/.rehearsal-acls 2>/dev/null; fi; true",
		);
		if (saved.code)
			throw new Error(`${name}: ACL save failed: ${saved.stderr}`);
		await dockerOk(["pause", name]);
		try {
			await dockerOk(["commit", "--pause=false", name, tag]);
			await docker(["volume", "rm", "-f", volume]);
			await dockerOk(["volume", "create", volume]);
			await copyVolume(`${name}-docker`, volume);
		} finally {
			await dockerOk(["unpause", name]);
		}
		return { image: tag, volume };
	}

	/** Runs a root script on the VM (setup, assertions). */
	async root(vm: string, script: string, timeoutMs = 600_000) {
		return docker(["exec", "-i", "-u", "0", "-w", "/", vm, "bash", "-s"], {
			input: script,
			timeoutMs,
		});
	}

	/**
	 * A Freestyle-style fork: the VM's disk and Docker state, taken while it
	 * is paused, booted as a new VM; the task container is started again.
	 */
	async fork(source: string, slug: string) {
		const started = Date.now();
		const name = `${this.prefix}-fork-${++this.forkCount}`;
		const snapshot = await this.snapshot(source, `${name}-image`);
		await this.startFrom(snapshot, name);
		await docker(["volume", "rm", "-f", snapshot.volume]);
		this.forks.push({ source, slug, vm: name });
		return { vm: WorkspaceId(name), forkMs: Date.now() - started };
	}
	readonly forks: { source: string; slug: string; vm: string }[] = [];
	readonly destroyed: string[] = [];

	async destroy(name: string) {
		this.destroyed.push(name);
		await this.remove(name);
		if (name.includes("-fork-")) await docker(["rmi", "-f", `${name}-image`]);
	}

	async destroyAll() {
		for (const name of this.created) await this.destroy(name);
	}

	/** WorkspaceMachines over these containers. */
	machines(): WorkspaceMachines {
		const exec = async (
			vm: string,
			command: string,
			timeoutMs = 120_000,
		): Promise<CommandOutput> => {
			const started = Date.now();
			const result = await vmExec(
				[
					"exec",
					"-i",
					"-u",
					"ubuntu",
					"-w",
					"/home/ubuntu",
					"-e",
					"HOME=/home/ubuntu",
					"-e",
					"USER=ubuntu",
					vm,
					"bash",
					"-c",
					command,
				],
				{ timeoutMs },
			);
			if (
				process.env.REHEARSAL_TRACE &&
				new RegExp(process.env.REHEARSAL_TRACE).test(command)
			)
				console.log(
					`  [exec ${vm}] exit ${result.code}: ${command.slice(0, 300).replaceAll("\n", "; ")} => ${(result.stdout + result.stderr).slice(0, 300).replaceAll("\n", "; ")}`,
				);
			this.log.push({
				vm,
				command,
				exitCode: result.code,
				ms: Date.now() - started,
			});
			return {
				exitCode: result.code,
				stdout: result.stdout,
				stderr: result.stderr,
			};
		};
		const machines: WorkspaceMachines = {
			createProofWorkspace: async () => {
				throw new Error("Rehearsal VMs have no proof workspaces.");
			},
			destroySnapshot: async () => {},
			exec: (vm, command, timeoutMs) => exec(vm, command, timeoutMs),
			writeTextFile: async (vm, path, contents) => {
				const result = await vmExec(
					[
						"exec",
						"-i",
						"-u",
						"ubuntu",
						vm,
						"sh",
						"-c",
						'mkdir -p "$(dirname "$1")" && cat > "$1"',
						"sh",
						path,
					],
					{ input: contents, timeoutMs: 60_000 },
				);
				if (result.code)
					throw new Error(
						`writeTextFile ${path} failed: ${result.stderr.slice(-400)}`,
					);
			},
			readTextFile: async (vm, path) => {
				const result = await vmExec(
					["exec", "-u", "ubuntu", vm, "sh", "-c", 'cat -- "$1"', "sh", path],
					{ timeoutMs: 60_000 },
				);
				return result.code ? null : result.stdout;
			},
			destroy: async (vm) => this.destroy(vm),
			ensureRunning: async (vm) => {
				const state = await docker(["inspect", "-f", "{{.State.Running}}", vm]);
				if (state.stdout.trim() !== "true")
					throw new Error(`Rehearsal VM ${vm} is not running.`);
				return vm;
			},
			isRunning: async (vm) =>
				(
					await docker(["inspect", "-f", "{{.State.Running}}", vm])
				).stdout.trim() === "true",
			exposeHttp: async () => {
				throw new Error("Rehearsal VMs expose no HTTP.");
			},
			destroyOrphans: async () => [],
			snapshotEnvironment: async () => {
				throw new Error("Rehearsal VMs take no environment snapshots.");
			},
			provisionSession: async () => {
				throw new Error("Rehearsal VMs provision no sessions.");
			},
			forkWorkspace: (source, slug) => this.fork(source, slug),
		};
		return machines;
	}
}

/** One copy at a time: parallel copies of ~700 MB starve the Docker host. */
let copying: Promise<unknown> = Promise.resolve();
function copyVolume(from: string, to: string) {
	const next = copying.then(() => copyVolumeNow(from, to));
	copying = next.catch(() => {});
	return next;
}

async function copyVolumeNow(from: string, to: string) {
	await dockerOk([
		"run",
		"--rm",
		"-v",
		`${from}:/from:ro`,
		"-v",
		`${to}:/to`,
		VM_IMAGE,
		"sh",
		"-c",
		"cp -a /from/. /to/",
	]);
}

/** Removes every rehearsal container and VM volume (not the image cache). */
export async function removeRehearsalVms() {
	const ids = (await docker(["ps", "-aq", "--filter", `label=${LABEL}`])).stdout
		.split("\n")
		.filter(Boolean);
	if (ids.length) await docker(["rm", "-f", ...ids]);
	const volumes = (
		await docker(["volume", "ls", "-q", "--filter", `label=${LABEL}`])
	).stdout
		.split("\n")
		.filter(Boolean);
	if (volumes.length) await docker(["volume", "rm", "-f", ...volumes]);
}
