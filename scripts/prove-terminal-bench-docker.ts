import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { Freestyle } from "freestyle";
import { posixShellCommand } from "../src/domain/posix-command";
import { GUEST_INTERNET_FIREWALL } from "../src/server/adapters/freestyle/proof-vm";
import { waitUntilVmRunning } from "../src/server/adapters/freestyle/wait-until-running";

// This zero-inference probe owns one disposable VM, never an existing machine.
const runId = randomUUID();
const directory = `.ytimesy/terminal-bench-pilot/docker-proof-${runId}`;
await mkdir(directory, { recursive: true, mode: 0o700 });
const save = (name: string, data: unknown) =>
	writeFile(`${directory}/${name}.json`, JSON.stringify(data, null, 2), {
		mode: 0o600,
	});
const client = new Freestyle({ apiKey: process.env.FREESTYLE_API_KEY });
const slug = `ytimesy-tbench-proof-${runId}`;
let vmId: string | undefined;
try {
	await save("resources", { runId, slug, vmId: null });
	const created = await client.vms.create({
		slug,
		snapshotId: "freestyle/ubuntu-sm",
		firewall: GUEST_INTERNET_FIREWALL,
		metadata: { purpose: "terminal-bench-docker-proof", evaluation_id: runId },
		autoDeleteSeconds: 1200,
		ttlSeconds: 1200,
		maxRunSeconds: 600,
		maxRunTotalSeconds: 600,
		automaticRestart: false,
		idleTimeoutSeconds: 120,
	});
	vmId = created.vmId;
	await save("resources", { runId, slug, vmId });
	await waitUntilVmRunning(created.vm, "Terminal-Bench Docker proof");
	const result = await created.vm.exec({
		command: posixShellCommand([
			"bash",
			"-lc",
			"set -eu; if ! command -v docker >/dev/null; then sudo apt-get update -qq && sudo apt-get install -y -qq docker.io; fi; sudo systemctl start docker; sudo docker info --format '{{.ServerVersion}}'; sudo docker run --rm alpine:3.23.4 sh -c 'printf docker-isolated-task-ok; test ! -e /var/run/docker.sock'",
		]),
		timeoutMs: 300000,
	});
	await save("probe", result);
	if (
		result.statusCode !== 0 ||
		!result.stdout?.includes("docker-isolated-task-ok")
	)
		throw new Error(
			"Docker task environment proof failed; see private probe output.",
		);
	console.info(`Docker proof passed. Evidence: ${directory}`);
} finally {
	if (vmId) await client.vms.delete(vmId);
	const remaining = (await client.vms.list()).vms.filter(
		(vm) => vm.slug === slug,
	);
	await save("cleanup", { remaining: remaining.map((vm) => vm.id) });
	if (remaining.length) {
		console.error(
			"Proof VM cleanup is incomplete; inspect its private ledger.",
		);
		process.exitCode = 1;
	}
}
