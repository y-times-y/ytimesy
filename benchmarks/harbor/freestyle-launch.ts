/**
 * Runs Terminal-Bench trials that exceed Daytona's per-sandbox limits on
 * Freestyle VMs: one VM per trial, sized to the task, running the official
 * `harbor run -e docker` (native amd64 Docker) with our Harbor agent. Each
 * trial's Harbor job directory is copied back for merging and upload.
 *
 *   node --env-file=.env --import tsx benchmarks/harbor/freestyle-launch.ts \
 *     <dataset-dir> <out-dir> <trials-per-task> <concurrency> task [task...]
 */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Freestyle } from "freestyle";
import { GUEST_INTERNET_FIREWALL } from "../../src/server/adapters/freestyle/proof-vm";
import { waitUntilVmRunning } from "../../src/server/adapters/freestyle/wait-until-running";

const [datasetDir, outDir, trialsArg, concurrencyArg, ...tasks] =
	process.argv.slice(2);
if (!datasetDir || !outDir || !tasks.length)
	throw new Error("usage: <dataset-dir> <out-dir> <trials> <concurrency> task...");
const trials = Number(trialsArg);
const concurrency = Number(concurrencyArg);
const client = new Freestyle({ apiKey: process.env.FREESTYLE_API_KEY as string });
// One agent-version label for every job, so Harbor groups all trials together.
const harness = process.env.YTIMESY_HARNESS_COMMIT ?? execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim();
const HARBOR = "harbor==0.24.0";
await mkdir(outDir, { recursive: true });
const log = (line: string) =>
	console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);

const files = {
	bundle: await readFile(".ytimesy/freestyle-harbor/builder-bridge.mjs"),
	agent: await readFile("benchmarks/harbor/ytimesy_agent.py"),
	mcp: await readFile("benchmarks/harbor/mcp_call.py"),
	key: (await readFile(".secrets/openai-api-key", "utf8")).trim(),
};

async function resources(task: string) {
	const toml = await readFile(`${datasetDir}/${task}/task.toml`, "utf8");
	const env = toml.slice(toml.indexOf("[environment]"));
	const value = (name: string, fallback: number) =>
		Number(new RegExp(`^${name}\\s*=\\s*([0-9.]+)`, "m").exec(env)?.[1] ?? fallback);
	return {
		cpu: value("cpus", 2),
		memory: value("memory_mb", 4096),
		storage: value("storage_mb", 10240),
	};
}

const BOOTSTRAP = `set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq docker.io docker-compose-v2 python3 curl xz-utils git >/dev/null
systemctl start docker
curl -fsSL https://nodejs.org/dist/v22.20.0/node-v22.20.0-linux-x64.tar.xz | tar -xJ -C /usr/local --strip-components=1
curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh >/dev/null
mkdir -p /opt/ytimesy/benchmarks/harbor /opt/ytimesy/.secrets /opt/jobs
touch /opt/ytimesy/benchmarks/__init__.py /opt/ytimesy/benchmarks/harbor/__init__.py
uvx --from ${HARBOR} harbor --version`;

async function runTrial(task: string, attempt: number) {
	const name = `tb4-freestyle-${task}-${attempt}`;
	const done = `${outDir}/${name}.tgz`;
	try {
		await readFile(done);
		log(`${name}: already collected`);
		return;
	} catch {}
	if ((process.env.YTIMESY_SKIP_TRIALS ?? "").split(",").includes(name)) {
		log(`${name}: skipped (running elsewhere)`);
		return;
	}
	const want = await resources(task);
	// Plan limits (Freestyle: 8 vCPUs per VM). A capped task runs with fewer CPUs
	// than specified, recorded by Harbor as --override-cpus and disclosed.
	const cap = Number(process.env.YTIMESY_CPU_CAP ?? 0);
	if (cap && want.cpu > cap) want.cpu = cap;
	// Capacity errors are retried with backoff; they are not trial outcomes.
	const createVm = async (options: object) => {
		for (let attempt = 1; ; attempt++) {
			try {
				return await client.vms.create(options as never);
			} catch (error) {
				if (attempt >= 20) throw error;
				log(`${name}: VM create failed (${(error as Error).message.slice(0, 80)}); retrying`);
				await new Promise((r) => setTimeout(r, Math.min(300_000, 15_000 * attempt)));
			}
		}
	};
	const created = await createVm({
		slug: `ytimesy-harbor-${task}-${attempt}-${Date.now()}`.slice(0, 60),
		snapshotId: "freestyle/ubuntu-sm",
		firewall: GUEST_INTERNET_FIREWALL,
		ttlSeconds: 43200,
		autoDeleteSeconds: 43200,
		maxRunSeconds: 36000,
		maxRunTotalSeconds: 36000,
		idleTimeoutSeconds: null,
		automaticRestart: false,
		metadata: { purpose: "terminal-bench-harbor", trial: name },
	});
	const vm = created.vm;
	// One exec is capped at 5 minutes, so long steps run detached and are polled.
	const sh = async (command: string, timeoutMs = 240_000) => {
		const result = (await vm.exec({
			command: `bash -lc ${JSON.stringify(command)}`,
			linuxUser: "root",
			timeoutMs,
		})) as { statusCode?: number | null; stdout?: string | null; stderr?: string | null };
		if (result.statusCode !== 0)
			throw new Error(`${command.slice(0, 60)} failed (${result.statusCode}): ${(result.stderr ?? "").slice(-600)}`);
		return result.stdout ?? "";
	};
	const detached = async (label: string, script: string, limitMs: number) => {
		await vm.fs.writeTextFile(`/opt/${label}.sh`, script);
		// The wrapper lives in a file so no shell quoting can expand $? early.
		await vm.fs.writeTextFile(
			`/opt/${label}-wrapper.sh`,
			`bash /opt/${label}.sh > /opt/${label}.log 2>&1; echo $? > /opt/${label}.exit\n`,
		);
		await sh(`rm -f /opt/${label}.exit && nohup setsid bash /opt/${label}-wrapper.sh >/dev/null 2>&1 &`);
		const deadline = Date.now() + limitMs;
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 30_000));
			const exit = (await sh(`cat /opt/${label}.exit 2>/dev/null || true`).catch(() => "")).trim();
			if (exit) {
				if (exit !== "0")
					throw new Error(`${label} exited ${exit}: ${(await sh(`tail -c 800 /opt/${label}.log`).catch(() => "")).trim()}`);
				return;
			}
		}
		throw new Error(`${label} did not finish in time`);
	};
	try {
		const data = await waitUntilVmRunning(vm, name);
		// The task's own size plus headroom for Docker and the Harbor coordinator.
		// Headroom when the plan allows it (8 vCPUs per VM); otherwise the task's exact size.
		const storage = Math.max(data.resources.storage, Math.min(want.storage + 25600, 76800));
		const exact = {
			cpu: Math.max(data.resources.cpu, want.cpu),
			memory: Math.max(data.resources.memory, want.memory),
			storage,
		};
		const target = {
			cpu: Math.min(8, Math.max(exact.cpu, want.cpu + 2)),
			memory: Math.max(exact.memory, want.memory + 4096),
			storage,
		};
		await vm
			.resize(exact.cpu > 8 ? exact : target)
			.catch(() => vm.resize(exact))
			.catch(() => vm.resize({ ...exact, storage: Math.max(data.resources.storage, 51200) }));
		// Freestyle applies CPU changes on start() and hot-plugs them a few seconds
		// later; verify inside the guest once they are online.
		await vm.start();
		await waitUntilVmRunning(vm, name);
		let cpus = 0;
		for (let wait = 0; wait < 18; wait++) {
			cpus = Number((await sh("nproc").catch(() => "0")).trim());
			if (cpus >= want.cpu) break;
			await new Promise((r) => setTimeout(r, 10_000));
		}
		if (cpus < want.cpu)
			throw new Error(`VM has ${cpus} CPUs after resize; task needs ${want.cpu}`);
		log(`${name}: VM ${created.vmId} ${JSON.stringify(target)}; bootstrapping`);
		await detached("bootstrap", BOOTSTRAP, 1_800_000);
		// Docker reads the CPU count when the daemon starts; restart it now that the
		// hot-plugged CPUs are online and confirm Docker sees the task's CPUs.
		await sh("systemctl restart docker");
		const dockerCpus = Number((await sh("docker info --format '{{.NCPU}}'").catch(() => "0")).trim());
		if (dockerCpus < want.cpu)
			throw new Error(`Docker sees ${dockerCpus} CPUs; task needs ${want.cpu}`);
		await vm.fs.writeFile("/opt/ytimesy/builder-bridge.mjs", files.bundle);
		await vm.fs.writeFile("/opt/ytimesy/benchmarks/harbor/ytimesy_agent.py", files.agent);
		await vm.fs.writeFile("/opt/ytimesy/benchmarks/harbor/mcp_call.py", files.mcp);
		await vm.fs.writeTextFile("/opt/ytimesy/.secrets/openai-api-key", files.key);
		await sh("chmod 600 /opt/ytimesy/.secrets/openai-api-key");
		log(`${name}: harbor run started`);
		// Harbor and our bridge share the VM with the task, so they run at the lowest
		// CPU priority: the task's own processes always get the CPUs first.
		// The official run; Harbor enforces the task's own timeouts inside.
		await detached(
			"harbor",
			`cd /opt/ytimesy && export YTIMESY_REPO=/opt/ytimesy YTIMESY_BRIDGE_BUNDLE=/opt/ytimesy/builder-bridge.mjs YTIMESY_HARNESS_VERSION=v13-shell-${harness} PYTHONPATH=/opt/ytimesy && nice -n 19 uvx --from ${HARBOR} harbor run -d terminal-bench/terminal-bench@4.0.0 -i terminal-bench/${task} -k 1 -n 1 -a benchmarks.harbor.ytimesy_agent:YtimesyAgent -e docker --jobs-dir /opt/jobs --job-name ${name} ${process.env.YTIMESY_HARBOR_EXTRA ?? ""}`,
			10 * 3600_000,
		).catch((error) => log(`${name}: harbor run: ${(error as Error).message.slice(0, 200)}`));
		await sh(`cp /opt/harbor.log /opt/jobs/${name}/freestyle-run.log 2>/dev/null || true`);
		// A failure before the agent started is infrastructure, not a trial outcome:
		// report it so the trial is retried on a fresh VM.
		const started = (
			await sh(
				`python3 -c "import json,glob;r=[json.load(open(f)) for f in glob.glob('/opt/jobs/${name}/*__*/result.json')];print(int(bool(r and (r[0].get('agent_execution') or {}).get('started_at'))))"`,
			).catch(() => "0")
		).trim();
		if (started !== "1") {
			const why = await sh(
				`python3 -c "import json,glob;r=[json.load(open(f)) for f in glob.glob('/opt/jobs/${name}/*__*/result.json')];print((r[0].get('exception_info') or {}).get('exception_message','')[-600:] if r else 'no result')"; tail -c 600 /opt/harbor.log`,
			).catch((error) => (error as Error).message);
			throw new Error(`trial failed before the agent started: ${why.replace(/\s+/g, " ")}`);
		}
		await sh(`cd /opt/jobs && tar czf /opt/job.tgz ${name}`);
		const archive = await vm.fs.readFile("/opt/job.tgz");
		await writeFile(done, archive);
		execFileSync("tar", ["xzf", done, "-C", outDir]);
		log(`${name}: collected (${archive.length} bytes)`);
		return true;
	} catch (error) {
		log(`${name}: FAILED ${(error as Error).message.slice(0, 1400)}`);
		return false;
	} finally {
		await client.vms.ref(created.vmId).delete().catch(() => {});
	}
}

async function runTrialWithRetries(task: string, attempt: number) {
	for (let tries = 1; tries <= 3; tries++) {
		if ((await runTrial(task, attempt)) !== false) return;
		log(`tb4-freestyle-${task}-${attempt}: infrastructure retry ${tries}`);
	}
}

const queue = tasks.flatMap((task) =>
	Array.from({ length: trials }, (_, index) => [task, index + 1] as const),
);
log(`${queue.length} trials on Freestyle (harness ${harness}), ${concurrency} at a time`);
await Promise.all(
	Array.from({ length: concurrency }, async () => {
		for (let item = queue.shift(); item; item = queue.shift())
			await runTrialWithRetries(item[0], item[1]);
	}),
);
log("all Freestyle trials finished");
