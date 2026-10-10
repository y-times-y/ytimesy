import { randomUUID } from "node:crypto";
import { Freestyle } from "freestyle";
import { z } from "zod";
import { WorkspaceId } from "../../src/domain/ids";
import {
	posixShellCommand,
	posixShellQuoted as quote,
} from "../../src/domain/posix-command";
import {
	type EnvironmentRecipe,
	environmentRecipe,
} from "../../src/domain/project-environment";
import { GUEST_INTERNET_FIREWALL } from "../../src/server/adapters/freestyle/proof-vm";
import { waitUntilVmRunning } from "../../src/server/adapters/freestyle/wait-until-running";
import type {
	CommandOutput,
	WorkspaceMachines,
} from "../../src/server/services/workspace-machines";
import { terminalBenchHostCommand } from "./terminal-bench-host-command";

const pinnedImage = z.string().regex(/^[\w./:-]+@sha256:[a-f0-9]{64}$/);
const artifactPath = z
	.string()
	// Tasks export from the working tree or from /tmp (e.g. a submitted patch).
	.regex(/^\/(?:app|tmp)(?:\/[\w./-]*)?\/?$/)
	.refine((path) => !path.split("/").includes(".."));
export const terminalBenchTaskSchema = z
	.object({
		id: z.string().regex(/^[a-z0-9-]+$/),
		instruction: z.string().min(1),
		image: pinnedImage,
		artifacts: z.array(artifactPath).min(1),
		compose: z.record(z.string(), z.unknown()),
		// Tasks declare their own size; VMs are resized to match (within a cap).
		resources: z.object({
			cpus: z.number().int().min(1).max(8),
			memoryMb: z.number().int().min(1024).max(16384),
			storageMb: z.number().int().min(10240).max(16384),
		}),
		agentTimeoutSeconds: z.number().int().positive().max(28800),
		verifierMode: z.literal("separate"),
		sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();
export type TerminalBenchTask = z.infer<typeof terminalBenchTaskSchema>;

/** Operator-owned checks are frozen before inference; hidden graders stay outside the guest. */
export function terminalBenchVerificationSetup(
	verification?: EnvironmentRecipe,
) {
	if (!verification) return "";
	const policy = environmentRecipe.parse(verification);
	if (!policy.checks.length && !policy.verify.length)
		throw new Error("Benchmark admission policy requires an explicit check.");
	return `mkdir -p .ytimesy\nprintf '%s\\n' ${quote(JSON.stringify(policy))} > .ytimesy/environment.json\ngit add -f .ytimesy/environment.json`;
}

export function terminalBenchCompose(task: TerminalBenchTask) {
	if (Object.keys(task.compose).some((key) => key !== "services"))
		throw new Error("Only isolated task services are supported.");
	const services = task.compose.services as
		| Record<string, Record<string, unknown>>
		| undefined;
	if (!services?.main) throw new Error("Task has no main service.");
	for (const [name, service] of Object.entries(services)) {
		if (
			!/^[a-z0-9-]+$/.test(name) ||
			!service ||
			typeof service !== "object" ||
			Array.isArray(service)
		)
			throw new Error("Invalid task service.");
		const allowed = new Set([
			"image",
			"command",
			"entrypoint",
			"environment",
			"depends_on",
			"network_mode",
			"expose",
			"healthcheck",
			"working_dir",
			"stdin_open",
			"tty",
		]);
		if (Object.keys(service).some((key) => !allowed.has(key)))
			throw new Error(`Unsupported task service configuration: ${name}`);
		pinnedImage.parse(service.image);
		if (
			service.build ||
			service.volumes ||
			service.ports ||
			service.privileged ||
			service.devices ||
			service.cap_add ||
			service.pid ||
			service.ipc ||
			service.userns_mode
		)
			throw new Error(
				`Unsupported task service authority or host mounts: ${name}`,
			);
		if (
			service.network_mode !== undefined &&
			(typeof service.network_mode !== "string" ||
				!/^service:[a-z0-9-]+$/.test(service.network_mode) ||
				!services[service.network_mode.slice(8)])
		)
			throw new Error("Only task-sidecar network sharing is supported.");
	}
	if (services.main.image !== task.image)
		throw new Error("Task image differs from its pinned main service.");
	return JSON.stringify(task.compose);
}

const composeArguments = [
	"sudo",
	"docker",
	"compose",
	"--project-name",
	"ytimesy-bench",
	"-f",
	"/home/ubuntu/terminal-bench-compose.json",
];
export const terminalBenchExecCommand = (command: string, timeoutMs: number) =>
	posixShellCommand([
		...composeArguments,
		"exec",
		"-T",
		"--user",
		"root",
		"main",
		"timeout",
		"--signal=TERM",
		"--kill-after=5s",
		String(Math.max(1, Math.min(1800, Math.ceil(timeoutMs / 1000)))),
		"bash",
		"-lc",
		command,
	]);

export const terminalBenchShellPrerequisites = `apt-get update -qq
apt-get install -y -qq git python3 curl xz-utils ca-certificates ripgrep tmux
rg --version
printf 'ytimesy-rg-preflight\\n' | rg --fixed-strings --quiet ytimesy-rg-preflight`;

/** One guest VM per writer. Docker runs pinned task images and sidecars;
 * snapshots preserve the prepared environment. No platform credentials enter
 * guests. This is an operator-only adapter, not a production VM provider. */
/**
 * Freestyle reports temporary capacity pressure before creating anything; a
 * later attempt is safe because no VM exists yet. Other errors fail at once.
 */
async function retryCapacity<T>(create: () => Promise<T>) {
	for (let attempt = 1; ; attempt++) {
		try {
			return await create();
		} catch (error) {
			const transient =
				error instanceof Error &&
				/under pressure|resource limits are being prepared/i.test(
					error.message,
				);
			if (!transient || attempt >= 8) throw error;
			await new Promise((done) => setTimeout(done, 30_000 * attempt));
		}
	}
}

export function createTerminalBenchMachines(input: {
	apiKey: string;
	runId: string;
	onResources: (resources: {
		vmIds: string[];
		snapshotIds: string[];
	}) => Promise<void>;
	maxVms?: number;
}) {
	const client = new Freestyle({ apiKey: input.apiKey });
	const vmIds = new Set<string>();
	const snapshotIds = new Set<string>();
	let reservations = 0;
	let snapshotReservations = 0;
	let writes = Promise.resolve();
	const persist = () => {
		const state = { vmIds: [...vmIds], snapshotIds: [...snapshotIds] };
		writes = writes.then(() => input.onResources(state));
		return writes;
	};
	const owned = (id: string) => {
		if (!vmIds.has(id)) throw new Error("Machine is outside this evaluation.");
		return client.vms.ref(id);
	};
	const hostExec = async (
		id: string,
		command: string,
		timeoutMs = 120000,
	): Promise<CommandOutput> => {
		return terminalBenchHostCommand(owned(id), command, timeoutMs);
	};
	const checkedHostExec = async (
		id: string,
		command: string,
		timeoutMs = 120000,
	) => {
		const result = await hostExec(id, command, timeoutMs);
		if (result.exitCode)
			throw new Error(
				`Task host command failed (${result.exitCode}): ${result.stderr.slice(-1200)}`,
			);
		return result.stdout;
	};
	async function create(
		slug: string,
		snapshotId: string,
		requested?: TerminalBenchTask["resources"],
	) {
		if (reservations >= (input.maxVms ?? 12))
			throw new Error("Pilot VM allocation cap reached.");
		if (snapshotId !== "freestyle/ubuntu-sm" && !snapshotIds.has(snapshotId))
			throw new Error("Snapshot is outside this evaluation.");
		reservations++;
		const created = await retryCapacity(() =>
			client.vms.create({
				slug,
				snapshotId,
				firewall: GUEST_INTERNET_FIREWALL,
				metadata: {
					purpose: "terminal-bench-pilot",
					evaluation_id: input.runId,
				},
				ttlSeconds: 5400,
				autoDeleteSeconds: 5400,
				maxRunSeconds: 3600,
				maxRunTotalSeconds: 3600,
				automaticRestart: false,
				idleTimeoutSeconds: 180,
			}),
		);
		vmIds.add(created.vmId);
		await persist();
		const data = await waitUntilVmRunning(created.vm, "Terminal-Bench VM");
		// Match the task's declared CPU and memory, as production resizes copies.
		const target = {
			cpu: Math.max(data.resources.cpu, requested?.cpus ?? 0),
			memory: Math.max(data.resources.memory, requested?.memoryMb ?? 0),
			storage: data.resources.storage,
		};
		if (
			target.cpu !== data.resources.cpu ||
			target.memory !== data.resources.memory
		)
			await created.vm.resize(target);
		if (target.cpu > 8 || target.memory > 16384 || target.storage > 16384)
			throw new Error("Task VM exceeds the evaluation resource envelope.");
		return WorkspaceId(created.vmId);
	}
	const unsupported = async (): Promise<never> => {
		throw new Error("Capability is not available to benchmark tasks.");
	};
	const machines: WorkspaceMachines = {
		createProofWorkspace: unsupported,
		snapshotAuthenticatedWorkspace: unsupported,
		exposeHttp: unsupported,
		destroyOrphans: unsupported,
		async ensureRunning(id) {
			const vm = owned(id);
			if ((await vm.data()).state !== "running") await vm.start();
			await waitUntilVmRunning(vm, "Terminal-Bench VM");
			await checkedHostExec(
				id,
				posixShellCommand([...composeArguments, "exec", "-T", "main", "true"]),
			);
			return id;
		},
		async isRunning(id) {
			return (await owned(id).data()).state === "running";
		},
		exec: (id, command, timeoutMs = 120000) =>
			hostExec(
				id,
				terminalBenchExecCommand(command, timeoutMs),
				timeoutMs + 10000,
			),
		async writeTextFile(id, path, text) {
			const payload = Buffer.from(text).toString("base64");
			const code =
				"import base64,pathlib,sys; p=pathlib.Path(sys.argv[1]); p.parent.mkdir(parents=True,exist_ok=True); p.write_bytes(base64.b64decode(sys.argv[2]))";
			const result = await machines.exec(
				id,
				`python3 -c ${quote(code)} ${quote(path)} ${quote(payload)}`,
				15000,
			);
			if (result.exitCode) throw new Error("Task file write failed.");
		},
		async readTextFile(id, path) {
			const code =
				"import pathlib,sys; p=pathlib.Path(sys.argv[1]); sys.exit(3) if not p.exists() else sys.stdout.write(p.read_text())";
			const result = await machines.exec(
				id,
				`python3 -c ${quote(code)} ${quote(path)}`,
				15000,
			);
			if (result.exitCode === 3) return null;
			if (result.exitCode) throw new Error("Task file read failed.");
			return result.stdout;
		},
		async destroy(id) {
			await client.vms.delete(owned(id).id);
			vmIds.delete(id);
			await persist();
		},
		async destroySnapshot(id) {
			if (!snapshotIds.has(id))
				throw new Error("Snapshot is outside this evaluation.");
			await client.vms.snapshots.delete(id);
			snapshotIds.delete(id);
			await persist();
		},
		async snapshotEnvironment(id, _slug) {
			const snapshot = await owned(id).snapshot({
				slug: `ytimesy-tbench-${input.runId}-${++snapshotReservations}`,
				autoDeleteSeconds: 5400,
				ttlSeconds: 5400,
			});
			snapshotIds.add(snapshot.snapshotId);
			await persist();
			if (snapshot.snapshot.public)
				throw new Error("Benchmark snapshots must be private.");
			return snapshot.snapshotId;
		},
		async provisionSession(slug, snapshotId) {
			return create(slug, snapshotId);
		},
	};
	async function prepare(
		task: TerminalBenchTask,
		verification?: EnvironmentRecipe,
	) {
		const verificationSetup = terminalBenchVerificationSetup(verification);
		const compose = terminalBenchCompose(task);
		const id = await create(
			`ytimesy-tbench-${randomUUID()}`,
			"freestyle/ubuntu-sm",
			task.resources,
		);
		await checkedHostExec(
			id,
			"sudo apt-get update -qq && sudo apt-get install -y -qq docker.io docker-compose-v2 && sudo systemctl start docker",
			300000,
		);
		await owned(id).fs.writeTextFile(
			"/home/ubuntu/terminal-bench-compose.json",
			compose,
		);
		await checkedHostExec(
			id,
			posixShellCommand([...composeArguments, "up", "--detach", "--wait"]),
			600000,
		);
		// Harness prerequisites only; no task implementation or verifier assets.
		const installed = await machines.exec(
			id,
			`set -eu
${terminalBenchShellPrerequisites}
if ! command -v node >/dev/null; then
 curl -fsSL https://nodejs.org/dist/v22.20.0/node-v22.20.0-linux-x64.tar.xz -o /tmp/ytimesy-node.tar.xz
 curl -fsSL https://nodejs.org/dist/v22.20.0/SHASUMS256.txt -o /tmp/ytimesy-node-checksums
 cd /tmp
 grep '  node-v22.20.0-linux-x64.tar.xz$' /tmp/ytimesy-node-checksums | sed 's/node-v22.20.0-linux-x64.tar.xz/ytimesy-node.tar.xz/' | sha256sum --check --strict
 tar -xJf /tmp/ytimesy-node.tar.xz -C /usr/local --strip-components=1
 rm /tmp/ytimesy-node.tar.xz
fi
cd /app
git init --initial-branch=evaluation-frozen
git config user.name 'Evaluation fixture'
git config user.email 'evaluation@ytimesy.invalid'
printf '\nnode_modules/\n.next/\n.ytimesy/\n__pycache__/\n' >> .git/info/exclude
${verificationSetup}
git add -A
git commit --allow-empty -m 'Frozen benchmark environment'
git update-ref refs/ytimesy/base HEAD
git remote add origin ${quote(`https://github.com/terminal-bench/${task.id}.git`)}
mkdir -p "$HOME"
ln -s /app "$HOME/${task.id}"
printf '/app\n' > /tmp/ytimesy-project-cwd
git rev-parse HEAD`,
			300000,
		);
		if (installed.exitCode)
			throw new Error(
				`Task harness prerequisites failed: ${installed.stderr.slice(-1200)}`,
			);
		const commit = installed.stdout.trim().split("\n").at(-1) as string;
		if (!/^[a-f0-9]{40}$/.test(commit))
			throw new Error("Frozen task checkout is unavailable.");
		const snapshotId = await machines.snapshotEnvironment(
			id,
			`ytimesy-tbench-${randomUUID()}`,
		);
		await owned(id).pause();
		return { vmId: id, snapshotId, commit };
	}
	async function exportArtifacts(id: string, paths: readonly string[]) {
		for (const path of paths) artifactPath.parse(path);
		const remote = "/home/ubuntu/terminal-bench-artifacts.tar.gz";
		const tar = `tar --exclude=.git --exclude=.ytimesy -czf /tmp/ytimesy-benchmark-artifacts.tar.gz -C / ${paths.map((path) => quote(path.replace(/^\//, ""))).join(" ")}`;
		const result = await machines.exec(WorkspaceId(id), tar, 60000);
		if (result.exitCode) throw new Error("Task artifact capture failed.");
		await checkedHostExec(
			id,
			`container=$(sudo docker compose --project-name ytimesy-bench -f /home/ubuntu/terminal-bench-compose.json ps -q main)\nsudo docker cp "$container:/tmp/ytimesy-benchmark-artifacts.tar.gz" ${quote(remote)}\nsudo chown ubuntu:ubuntu ${quote(remote)}\ntest "$(stat -c %s ${quote(remote)})" -le 67108864`,
			60000,
		);
		return owned(id).fs.readFile(remote);
	}
	/** Trusted evaluator inputs only; this capability is not exposed to the model. */
	async function copyArchive(id: string, bytes: Uint8Array) {
		const remote = "/home/ubuntu/terminal-bench-input.tar.gz";
		await owned(id).fs.writeFile(remote, new Blob([new Uint8Array(bytes)]));
		await checkedHostExec(
			id,
			`container=$(sudo docker compose --project-name ytimesy-bench -f /home/ubuntu/terminal-bench-compose.json ps -q main)\nsudo docker cp ${quote(remote)} "$container:/tmp/ytimesy-evaluator-input.tar.gz"`,
		);
	}
	async function uploadArchive(
		id: string,
		bytes: Uint8Array,
		destination: "/tests" | "/solution" | "/app",
	) {
		await copyArchive(id, bytes);
		const code =
			"import pathlib,sys,tarfile; p=pathlib.Path(sys.argv[1]); p.mkdir(parents=True,exist_ok=True); a=tarfile.open('/tmp/ytimesy-evaluator-input.tar.gz'); members=a.getmembers(); assert all(not pathlib.PurePosixPath(m.name).is_absolute() and '..' not in pathlib.PurePosixPath(m.name).parts and (m.isfile() or m.isdir()) for m in members), 'Unsafe trusted archive'; a.extractall(p,members=members)";
		const result = await machines.exec(
			WorkspaceId(id),
			`python3 -c ${quote(code)} ${quote(destination)}`,
			30000,
		);
		if (result.exitCode)
			throw new Error(
				`Trusted evaluator input upload failed: ${result.stderr.slice(-1200)}`,
			);
	}
	async function restoreArtifacts(
		id: string,
		bytes: Uint8Array,
		paths: readonly string[],
	) {
		for (const path of paths) artifactPath.parse(path);
		await copyArchive(id, bytes);
		const code =
			"import json,pathlib,shutil,sys,tarfile; allowed=json.loads(sys.argv[1]); a=tarfile.open('/tmp/ytimesy-evaluator-input.tar.gz'); members=a.getmembers(); assert all(not pathlib.PurePosixPath(m.name).is_absolute() and '..' not in pathlib.PurePosixPath(m.name).parts and (m.isfile() or m.isdir()) and any('/'+m.name.rstrip('/')==p.rstrip('/') or ('/'+m.name).startswith(p.rstrip('/')+'/') for p in allowed) for m in members), 'Unsafe task artifact'; [(shutil.rmtree(p) if p.is_dir() and not p.is_symlink() else p.unlink()) for s in allowed if (p:=pathlib.Path(s)).exists() or p.is_symlink()]; a.extractall('/',members=members)";
		const result = await machines.exec(
			WorkspaceId(id),
			`python3 -c ${quote(code)} ${quote(JSON.stringify(paths))}`,
			60000,
		);
		if (result.exitCode)
			throw new Error(
				`Safe task artifact restoration failed: ${result.stderr.slice(-1200)}`,
			);
	}
	async function cleanup() {
		const errors: unknown[] = [];
		// Recover uncertain create responses using this run's exact ownership tag.
		for (const vm of (await client.vms.list()).vms)
			if (vm.metadata?.evaluation_id === input.runId) vmIds.add(vm.id);
		for (const snapshot of (await client.vms.snapshots.list({ limit: 1000 }))
			.snapshots)
			if (
				snapshot.slug?.startsWith(`ytimesy-tbench-${input.runId}-`) &&
				!snapshot.public
			)
				snapshotIds.add(snapshot.id);
		for (const id of [...vmIds])
			try {
				await machines.destroy(WorkspaceId(id));
			} catch (error) {
				errors.push(error);
			}
		for (const id of [...snapshotIds])
			try {
				await client.vms.snapshots.delete(id);
				snapshotIds.delete(id);
				await persist();
			} catch (error) {
				errors.push(error);
			}
		const leftovers = (await client.vms.list()).vms.filter(
			(vm) => vm.metadata?.evaluation_id === input.runId,
		);
		if (errors.length || leftovers.length)
			throw new Error(
				"Pilot cleanup incomplete; reconcile its private resource ledger.",
			);
	}
	return {
		machines,
		prepare,
		exportArtifacts,
		uploadArchive,
		restoreArtifacts,
		cleanup,
	};
}
