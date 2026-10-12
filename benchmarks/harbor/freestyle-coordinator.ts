/**
 * Runs a Harbor job's coordinator on a Freestyle VM instead of the operator's
 * laptop, so an overnight run survives the laptop sleeping or changing
 * networks. The VM runs `harbor run` with our agent; sandboxes stay wherever
 * the job puts them (e.g. Daytona).
 *
 *   node --env-file=.env --import tsx benchmarks/harbor/freestyle-coordinator.ts start <state.json> -- <harbor run args...>
 *   ... status <state.json>     # progress counts and log tail
 *   ... collect <state.json> <dir>   # copy the job directory back
 *   ... delete <state.json>
 */
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { Freestyle } from "freestyle";
import { GUEST_INTERNET_FIREWALL } from "../../src/server/adapters/freestyle/proof-vm";
import { waitUntilVmRunning } from "../../src/server/adapters/freestyle/wait-until-running";

const [mode, statePath, ...rest] = process.argv.slice(2);
const client = new Freestyle({ apiKey: process.env.FREESTYLE_API_KEY as string });
const HARBOR = "harbor==0.24.0";

type State = { vmId: string; jobName: string; harness: string };
const vmOf = (state: State) => client.vms.ref(state.vmId);
async function sh(state: State, command: string, timeoutMs = 240_000) {
	const result = (await vmOf(state).exec({
		command: `bash -lc ${JSON.stringify(command)}`,
		linuxUser: "root",
		timeoutMs,
	})) as { statusCode?: number | null; stdout?: string | null; stderr?: string | null };
	if (result.statusCode !== 0)
		throw new Error(`${command.slice(0, 60)} failed (${result.statusCode}): ${(result.stderr ?? "").slice(-600)}`);
	return result.stdout ?? "";
}
const poll = async (state: State, file: string, limitMs: number) => {
	const deadline = Date.now() + limitMs;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 15_000));
		const exit = (await sh(state, `cat ${file} 2>/dev/null || true`).catch(() => "")).trim();
		if (exit) return exit;
	}
	throw new Error(`${file} not written in time`);
};

if (mode === "start-script") {
	// Bootstraps a coordinator with everything both jobs need, then runs a
	// local script on it: Daytona harbor runs and/or the Freestyle launcher.
	const [script] = rest;
	const harness = process.env.YTIMESY_HARNESS_COMMIT ?? execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim();
	const created = await client.vms.create({
		slug: `ytimesy-coordinator-${Date.now()}`,
		snapshotId: "freestyle/ubuntu-sm",
		firewall: GUEST_INTERNET_FIREWALL,
		ttlSeconds: 86400,
		autoDeleteSeconds: 86400,
		maxRunSeconds: 86400,
		maxRunTotalSeconds: 86400,
		idleTimeoutSeconds: null,
		automaticRestart: false,
		metadata: { purpose: "harbor-coordinator" },
	} as never);
	const state: State = { vmId: created.vmId, jobName: "tb4-full-daytona", harness };
	await writeFile(statePath, JSON.stringify(state, null, 2));
	const data = await waitUntilVmRunning(created.vm, "coordinator");
	await created.vm.resize({ cpu: 16, memory: 32768, storage: Math.max(data.resources.storage, 40960) });
	console.log(`coordinator VM ${created.vmId} (16 CPU / 32 GB); bootstrapping`);
	const vm = created.vm;
	await vm.fs.writeTextFile(
		"/opt/bootstrap.sh",
		`set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq python3 curl xz-utils git >/dev/null
curl -fsSL https://nodejs.org/dist/v22.20.0/node-v22.20.0-linux-x64.tar.xz | tar -xJ -C /usr/local --strip-components=1
curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh >/dev/null
mkdir -p /opt/ytimesy/benchmarks/harbor /opt/ytimesy/.secrets /opt/ytimesy/.ytimesy/freestyle-harbor /opt/jobs /opt/freestyle-jobs
touch /opt/ytimesy/benchmarks/__init__.py /opt/ytimesy/benchmarks/harbor/__init__.py
uvx --from ${HARBOR} --with daytona harbor --version
`,
	);
	await vm.fs.writeTextFile("/opt/bootstrap-wrapper.sh", "bash /opt/bootstrap.sh > /opt/bootstrap.log 2>&1; echo $? > /opt/bootstrap.exit\n");
	await sh(state, "nohup setsid bash /opt/bootstrap-wrapper.sh >/dev/null 2>&1 &");
	const booted = await poll(state, "/opt/bootstrap.exit", 1_200_000);
	if (booted !== "0") throw new Error(`bootstrap failed: ${await sh(state, "tail -c 800 /opt/bootstrap.log")}`);
	const bundle = await readFile(".ytimesy/freestyle-harbor/builder-bridge.mjs");
	await vm.fs.writeFile("/opt/ytimesy/builder-bridge.mjs", bundle);
	await vm.fs.writeFile("/opt/ytimesy/.ytimesy/freestyle-harbor/builder-bridge.mjs", bundle);
	await vm.fs.writeFile("/opt/ytimesy/freestyle-launch.mjs", await readFile(".ytimesy/freestyle-harbor/freestyle-launch.mjs"));
	await vm.fs.writeFile("/opt/ytimesy/dataset.tgz", await readFile(".ytimesy/freestyle-harbor/dataset.tgz"));
	await vm.fs.writeFile("/opt/ytimesy/benchmarks/harbor/ytimesy_agent.py", await readFile("benchmarks/harbor/ytimesy_agent.py"));
	for (const key of ["openai-api-key", "daytona-api-key"])
		await vm.fs.writeTextFile(`/opt/ytimesy/.secrets/${key}`, (await readFile(`.secrets/${key}`, "utf8")).trim());
	await vm.fs.writeTextFile("/opt/ytimesy/.secrets/freestyle-api-key", (process.env.FREESTYLE_API_KEY as string).trim());
	await sh(state, "chmod 600 /opt/ytimesy/.secrets/* && cd /opt/ytimesy && tar xzf dataset.tgz");
	// Trials already collected elsewhere are not rerun (the launcher skips existing archives).
	for (const archive of (await import("node:fs")).readdirSync(".ytimesy/harbor-jobs/freestyle").filter((f) => f.endsWith(".tgz")))
		await vm.fs.writeFile(`/opt/freestyle-jobs/${archive}`, await readFile(`.ytimesy/harbor-jobs/freestyle/${archive}`));
	await vm.fs.writeTextFile("/opt/run.sh", `export YTIMESY_HARNESS_COMMIT=${harness}\n${await readFile(script, "utf8")}`);
	await vm.fs.writeTextFile("/opt/run-wrapper.sh", "bash /opt/run.sh > /opt/run.log 2>&1; echo $? > /opt/run.exit\n");
	await sh(state, "nohup setsid bash /opt/run-wrapper.sh >/dev/null 2>&1 &");
	console.log("coordinator script started");
} else if (mode === "start") {
	const args = rest[0] === "--" ? rest.slice(1) : rest;
	const jobName = args[args.indexOf("--job-name") + 1];
	// One agent-version label for every job, so Harbor groups all trials together.
const harness = process.env.YTIMESY_HARNESS_COMMIT ?? execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim();
	const created = await client.vms.create({
		slug: `ytimesy-coordinator-${Date.now()}`,
		snapshotId: "freestyle/ubuntu-sm",
		firewall: GUEST_INTERNET_FIREWALL,
		ttlSeconds: 86400,
		autoDeleteSeconds: 86400,
		maxRunSeconds: 86400,
		maxRunTotalSeconds: 86400,
		idleTimeoutSeconds: null,
		automaticRestart: false,
		metadata: { purpose: "harbor-coordinator", job: jobName },
	} as never);
	const state: State = { vmId: created.vmId, jobName, harness };
	await writeFile(statePath, JSON.stringify(state, null, 2));
	const data = await waitUntilVmRunning(created.vm, "coordinator");
	await created.vm.resize({ cpu: 16, memory: 32768, storage: Math.max(data.resources.storage, 40960) });
	console.log(`coordinator VM ${created.vmId} (16 CPU / 32 GB); bootstrapping`);
	const vm = created.vm;
	await vm.fs.writeTextFile(
		"/opt/bootstrap.sh",
		`set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq python3 curl xz-utils git >/dev/null
curl -fsSL https://nodejs.org/dist/v22.20.0/node-v22.20.0-linux-x64.tar.xz | tar -xJ -C /usr/local --strip-components=1
curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh >/dev/null
mkdir -p /opt/ytimesy/benchmarks/harbor /opt/ytimesy/.secrets /opt/jobs
touch /opt/ytimesy/benchmarks/__init__.py /opt/ytimesy/benchmarks/harbor/__init__.py
uvx --from ${HARBOR} --with daytona harbor --version
`,
	);
	await vmOf(state).fs.writeTextFile("/opt/bootstrap-wrapper.sh", "bash /opt/bootstrap.sh > /opt/bootstrap.log 2>&1; echo $? > /opt/bootstrap.exit\n");
	await sh(state, "nohup setsid bash /opt/bootstrap-wrapper.sh >/dev/null 2>&1 &");
	const booted = await poll(state, "/opt/bootstrap.exit", 1_200_000);
	if (booted !== "0") throw new Error(`bootstrap failed: ${await sh(state, "tail -c 800 /opt/bootstrap.log")}`);
	await vm.fs.writeFile("/opt/ytimesy/builder-bridge.mjs", await readFile(".ytimesy/freestyle-harbor/builder-bridge.mjs"));
	await vm.fs.writeFile("/opt/ytimesy/benchmarks/harbor/ytimesy_agent.py", await readFile("benchmarks/harbor/ytimesy_agent.py"));
	await vm.fs.writeTextFile("/opt/ytimesy/.secrets/openai-api-key", (await readFile(".secrets/openai-api-key", "utf8")).trim());
	await vm.fs.writeTextFile("/opt/ytimesy/.secrets/daytona-api-key", (await readFile(".secrets/daytona-api-key", "utf8")).trim());
	await sh(state, "chmod 600 /opt/ytimesy/.secrets/*");
	const quoted = args.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
	await vm.fs.writeTextFile(
		"/opt/run.sh",
		`cd /opt/ytimesy
export YTIMESY_REPO=/opt/ytimesy YTIMESY_BRIDGE_BUNDLE=/opt/ytimesy/builder-bridge.mjs YTIMESY_HARNESS_VERSION=v13-shell-${harness} PYTHONPATH=/opt/ytimesy
export DAYTONA_API_KEY=$(cat /opt/ytimesy/.secrets/daytona-api-key)
ulimit -n 65536
uvx --from ${HARBOR} --with daytona harbor run ${quoted} --jobs-dir /opt/jobs
`,
	);
	await vmOf(state).fs.writeTextFile("/opt/run-wrapper.sh", "bash /opt/run.sh > /opt/run.log 2>&1; echo $? > /opt/run.exit\n");
	await sh(state, "nohup setsid bash /opt/run-wrapper.sh >/dev/null 2>&1 &");
	console.log(`harbor run started on the coordinator VM: job ${jobName}`);
} else {
	const state = JSON.parse(await readFile(statePath, "utf8")) as State;
	if (mode === "status") {
		console.log(
			await sh(
				state,
				`J=/opt/jobs/${state.jobName}; echo "trials started $(ls -d $J/*__* 2>/dev/null | wc -l), finished $(ls $J/*__*/result.json 2>/dev/null | wc -l), exceptions $(ls $J/*__*/exception.txt 2>/dev/null | wc -l), exit $(cat /opt/run.exit 2>/dev/null || echo running)"; tail -c 600 /opt/run.log | tr '\\r' '\\n' | grep -v '^\\s*$' | tail -3`,
			),
		);
	} else if (mode === "collect") {
		const dir = rest[0];
		await sh(state, `cd /opt/jobs && tar czf /opt/job.tgz ${state.jobName} && cp /opt/run.log /opt/jobs/${state.jobName}/coordinator-run.log`, 240_000);
		await sh(state, `cd /opt/jobs && tar czf /opt/job.tgz ${state.jobName}`, 240_000);
		const archive = await vmOf(state).fs.readFile("/opt/job.tgz");
		await writeFile(`${dir}/${state.jobName}.tgz`, archive);
		execFileSync("tar", ["xzf", `${dir}/${state.jobName}.tgz`, "-C", dir]);
		console.log(`collected ${archive.length} bytes into ${dir}/${state.jobName}`);
	} else if (mode === "delete") {
		await vmOf(state).delete();
		console.log("coordinator VM deleted");
	}
}
