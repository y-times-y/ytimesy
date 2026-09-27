import { randomUUID } from "node:crypto";
import { Freestyle } from "freestyle";
import { WorkspaceId } from "#/domain/ids";
import { environmentRecipe } from "#/domain/project-environment";
import { runLongCommand } from "#/server/adapters/freestyle/long-command";
import { CHEAP_BASE_SNAPSHOT } from "#/server/adapters/freestyle/product-vm";
import { waitUntilVmRunning } from "#/server/adapters/freestyle/wait-until-running";
import { createFreestyleWorkspaceMachines } from "#/server/adapters/freestyle/workspace-machines";
import { startEnvironmentServices } from "#/server/services/environment-services";

// Infrastructure proof only: local fixture repos, no user sources, credentials, or inference.
const key = process.env.FREESTYLE_API_KEY;
if (!key) throw new Error("Freestyle key is required.");
const client = new Freestyle({ apiKey: key });
const machines = createFreestyleWorkspaceMachines(key);
const slug = `ytimesy-env-proof-${randomUUID().slice(0, 8)}`;
const created: string[] = [];
let snapshotId: string | undefined;
const started = Date.now();

async function create(suffix: string, source = CHEAP_BASE_SNAPSHOT) {
	const result = await client.vms.create({
		slug: `${slug}-${suffix}`,
		snapshotId: source,
		firewall: { rules: [] },
		ttlSeconds: 600,
		maxRunTotalSeconds: 300,
		idleTimeoutSeconds: 120,
		automaticRestart: false,
		metadata: { purpose: "ytimesy-env-proof" },
	});
	created.push(result.vmId);
	const data = await waitUntilVmRunning(result.vm, "Environment proof");
	if (
		data.resources.cpu > 8 ||
		data.resources.memory > 16384 ||
		data.resources.storage > 262144
	)
		throw new Error("Proof VM exceeds the approved resource envelope.");
	return result.vm;
}

try {
	const builder = await create("build");
	const ptyResult = await runLongCommand(
		builder.pty,
		["bash", "-c", "printf setup-pty-ok"],
		{},
		10_000,
	);
	if (ptyResult.exitCode !== 0 || ptyResult.stdout !== "setup-pty-ok")
		throw new Error("Setup PTY execution failed.");
	const timeoutResult = await runLongCommand(
		builder.pty,
		["sleep", "30"],
		{},
		1000,
	);
	if (timeoutResult.exitCode !== 124)
		throw new Error("Setup PTY timeout failed.");
	const setup = await builder.exec({
		command:
			"bash -lc 'set -eu; command -v python3; command -v tmux; command -v git; mkdir -p /home/ubuntu/web /home/ubuntu/api; git -C /home/ubuntu/web init -q; git -C /home/ubuntu/api init -q'",
		timeoutMs: 30000,
	});
	if (setup.statusCode !== 0)
		throw new Error("Proof image is missing required tools.");
	const repositories = ["web", "api"].map((name, index) => ({
		repositoryId: index + 1,
		fullName: `fixture/${name}`,
		directory: `/home/ubuntu/${name}`,
		commit: "fixture",
		recipe: environmentRecipe.parse({
			services: [
				{
					name,
					command: `python3 -m http.server ${3100 + index} --bind 127.0.0.1`,
					port: 3100 + index,
					timeoutSeconds: 15,
				},
			],
		}),
	}));
	for (const repo of repositories)
		await builder.fs.writeTextFile(
			`${repo.directory}/README.md`,
			`${repo.fullName}\n`,
		);
	await builder.fs.writeTextFile(
		"/tmp/ytimesy-environment.json",
		JSON.stringify({ version: 1, repositories }),
	);
	const snapshot = await builder.snapshot({
		slug: `${slug}-snapshot`,
		autoDeleteSeconds: 600,
		ttlSeconds: 600,
	});
	snapshotId = snapshot.snapshotId;
	if (snapshot.snapshot.public)
		throw new Error("Proof snapshot must be private.");
	await builder.pause();
	const guest = await create("restore", snapshotId);
	for (const repo of repositories) {
		if (
			(await guest.fs.readTextFile(`${repo.directory}/README.md`)) !==
			`${repo.fullName}\n`
		)
			throw new Error("Repository file did not survive snapshot restoration.");
	}
	try {
		await startEnvironmentServices(
			{
				...machines,
				exec: async (...args) => {
					const output = await machines.exec(...args);
					if (output.exitCode !== 0)
						console.info(JSON.stringify({ fixtureStartup: output }));
					return output;
				},
			},
			WorkspaceId(guest.id),
		);
	} catch (error) {
		const diagnostic = await guest.exec({
			command:
				"bash -lc 'tmux list-sessions; tmux capture-pane -pt ytimesy-1-web; ss -ltn; timeout 2 bash -c \"echo >/dev/tcp/127.0.0.1/3100\"; curl --max-time 2 -v http://127.0.0.1:3100/README.md'",
			timeoutMs: 15000,
		});
		console.info(
			JSON.stringify({
				fixtureDiagnostics: diagnostic.stdout,
				stderr: diagnostic.stderr,
			}),
		);
		throw error;
	}
	await startEnvironmentServices(machines, WorkspaceId(guest.id));
	const ready = await guest.exec({
		command:
			'bash -lc \'set -eu; curl -fsS http://127.0.0.1:3100/README.md; curl -fsS http://127.0.0.1:3101/README.md; test "$(tmux list-sessions -F "#{session_name}" | wc -l)" -eq 2\'',
		timeoutMs: 15000,
	});
	if (
		ready.statusCode !== 0 ||
		!ready.stdout?.includes("fixture/web") ||
		!ready.stdout.includes("fixture/api")
	)
		throw new Error(
			"Restored environment services failed readiness or duplicated terminals.",
		);
	console.info(
		JSON.stringify({
			result: "passed",
			scope:
				"setup PTY execution and timeout, two fixture repositories, private snapshot, restored files, service readiness, idempotent startup",
			elapsedSeconds: Math.round((Date.now() - started) / 1000),
		}),
	);
} finally {
	for (const id of created.reverse()) await client.vms.ref(id).delete();
	if (snapshotId) await client.vms.snapshots.delete(snapshotId);
	console.info("Disposable proof VMs and snapshot removed.");
}
