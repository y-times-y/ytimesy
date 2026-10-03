import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { Freestyle } from "freestyle";
import { WorkspaceId } from "#/domain/ids";
import { posixShellQuoted } from "#/domain/posix-command";
import { readFreestyleApiKey } from "#/server/adapters/freestyle/api-key";
import { JOB_WORKER_SLUG } from "#/server/adapters/freestyle/job-worker-vm";
import {
	scopedShellCommand,
	stopApiTurnCommands,
} from "#/server/services/api-command-scope";
import type { WorkspaceMachines } from "#/server/services/workspace-machines";

// Existing running worker only. This proof never creates, resumes, or reconfigures a VM.
const client = new Freestyle({ apiKey: Effect.runSync(readFreestyleApiKey()) });
const { vms } = await client.vms.list({ slug: JOB_WORKER_SLUG, limit: 1 });
const machine = vms[0];
if (machine?.state !== "running")
	throw new Error(
		"No already-running worker VM; refusing to provision or resume one.",
	);
const vm = client.vms.ref(machine.id);
const machines = {
	exec: async (_id: string, command: string, timeoutMs: number) => {
		const result = await vm.exec({
			command: `bash -lc ${posixShellQuoted(command)}`,
			timeoutMs,
			linuxUser: "ubuntu",
		});
		return {
			exitCode: result.statusCode,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
		};
	},
} as unknown as WorkspaceMachines;
const vmId = WorkspaceId(machine.id);
const temporary = await machines.exec(
	vmId,
	"mktemp -d /tmp/ytimesy-cancel-proof-XXXXXX",
	10_000,
);
const cwd = temporary.stdout.trim();
if (
	temporary.exitCode !== 0 ||
	!/^\/tmp\/ytimesy-cancel-proof-[a-zA-Z0-9]+$/.test(cwd)
)
	throw new Error("Invalid disposable proof directory.");
const turnId = randomUUID();
const workspace = { machines, vm: vmId, cwd };
let running: Promise<unknown> | undefined;
try {
	running = machines.exec(
		vmId,
		scopedShellCommand({
			turnId,
			cwd,
			command:
				"trap '' TERM; while true; do printf x >> ticks; sleep .05; done",
			seconds: 30,
		}),
		35_000,
	);
	let ticks = "";
	for (let attempt = 0; attempt < 20 && !ticks; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		ticks = (
			await machines.exec(
				vmId,
				`test ! -f ${posixShellQuoted(`${cwd}/ticks`)} || cat ${posixShellQuoted(`${cwd}/ticks`)}`,
				5000,
			)
		).stdout;
	}
	if (!ticks) throw new Error("Command did not start.");
	const began = Date.now();
	await stopApiTurnCommands(workspace, turnId);
	await running;
	const before = (
		await machines.exec(vmId, `cat ${posixShellQuoted(`${cwd}/ticks`)}`, 5000)
	).stdout;
	await new Promise((resolve) => setTimeout(resolve, 250));
	const after = (
		await machines.exec(vmId, `cat ${posixShellQuoted(`${cwd}/ticks`)}`, 5000)
	).stdout;
	if (before !== after) throw new Error("Cancelled command is still writing.");
	const late = await machines.exec(
		vmId,
		scopedShellCommand({
			turnId,
			cwd,
			command: "printf bad >> ticks",
			seconds: 5,
		}),
		10_000,
	);
	if (late.exitCode !== 130)
		throw new Error("Cancelled turn admitted a late command.");
	console.info(
		JSON.stringify({
			termResistantCommandStopped: true,
			lateStartRejected: true,
			elapsedMs: Date.now() - began,
			newVms: 0,
			inferenceCalls: 0,
		}),
	);
} finally {
	await stopApiTurnCommands(workspace, turnId);
	await running;
	const removed = await machines.exec(
		vmId,
		`rm -rf -- ${posixShellQuoted(cwd)} ${posixShellQuoted(`/tmp/ytimesy-api-command-scopes/${turnId}`)}`,
		10_000,
	);
	if (removed.exitCode) {
		console.error("Disposable proof cleanup failed.");
		process.exitCode = 1;
	}
}
