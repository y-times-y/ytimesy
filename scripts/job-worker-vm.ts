import { spawnSync } from "node:child_process";
import { openAsBlob } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { Freestyle, FreestyleApiError } from "freestyle";
import { pinnedCodexInstallCommand } from "#/domain/guest-cli-pin";
import { readFreestyleApiKey } from "#/server/adapters/freestyle/api-key";
import {
	JOB_WORKER_GUEST_CERT,
	JOB_WORKER_GUEST_GITHUB_KEY,
	JOB_WORKER_GUEST_ROOT,
	JOB_WORKER_IDLE_TIMEOUT_SECONDS,
	JOB_WORKER_SLUG,
	jobWorkerCreateVmFields,
	jobWorkerEnvFile,
	jobWorkerIdleNeedsUpdate,
} from "#/server/adapters/freestyle/job-worker-vm";
import { waitUntilVmRunning } from "#/server/adapters/freestyle/wait-until-running";

const guestArchive = `${JOB_WORKER_GUEST_ROOT}/app.tgz`;
const guestLog = `${JOB_WORKER_GUEST_ROOT}/worker.log`;
const rigkitBunVersion = "1.2.15";

async function main() {
	const apiKey = Effect.runSync(readFreestyleApiKey());
	const client = new Freestyle({ apiKey });
	const vm = await ensureWorkerVm(client);
	await waitUntilVmRunning(vm, "Job worker VM");
	await deployApp(vm);
	await deploySecrets(vm);
	await vm.fs.writeTextFile(
		`${JOB_WORKER_GUEST_ROOT}/start.sh`,
		guestStartScript(),
		{
			mode: 0o755,
		},
	);
	await vm.fs.writeTextFile(
		`${JOB_WORKER_GUEST_ROOT}/bootstrap.sh`,
		guestBootstrapScript(),
		{ mode: 0o755 },
	);
	await run(
		vm,
		`chown -R ubuntu:ubuntu ${JOB_WORKER_GUEST_ROOT} && bash ${JOB_WORKER_GUEST_ROOT}/bootstrap.sh`,
		300_000,
		"root",
	);
	const status = await run(
		vm,
		`pgrep -af '^node --import tsx src/server/jobs/worker.ts$' || true; tail -n 20 ${guestLog} || true`,
		30_000,
	);
	console.info((status.stdout ?? "").trim() || (status.stderr ?? "").trim());
	if (
		!/^\d+ node --import tsx src\/server\/jobs\/worker\.ts$/m.test(
			status.stdout ?? "",
		)
	) {
		throw new Error("Job worker process did not start.");
	}
	console.info(`Job worker is running on ${JOB_WORKER_SLUG}.`);
}

async function ensureWorkerVm(client: Freestyle) {
	const { vms } = await client.vms.list({ slug: JOB_WORKER_SLUG, limit: 1 });
	const existing = vms[0];
	if (existing) {
		const vm = client.vms.ref(existing.id);
		if (jobWorkerIdleNeedsUpdate(existing.idleTimeoutSeconds)) {
			await vm.update({
				idleTimeoutSeconds: JOB_WORKER_IDLE_TIMEOUT_SECONDS,
				maxRunSeconds: JOB_WORKER_IDLE_TIMEOUT_SECONDS,
				maxRunTotalSeconds: JOB_WORKER_IDLE_TIMEOUT_SECONDS,
				autoDeleteSeconds: JOB_WORKER_IDLE_TIMEOUT_SECONDS,
				automaticRestart: true,
			});
		}
		if (existing.state === "paused" || existing.state === "stopped") {
			await vm.start();
		}
		return vm;
	}
	try {
		const created = await client.vms.create(jobWorkerCreateVmFields());
		return created.vm;
	} catch (error) {
		if (!(error instanceof FreestyleApiError) || error.status !== 409)
			throw error;
		const { vms: recovered } = await client.vms.list({
			slug: JOB_WORKER_SLUG,
			limit: 1,
		});
		if (!recovered[0]) throw error;
		return client.vms.ref(recovered[0].id);
	}
}

async function deployApp(vm: ReturnType<Freestyle["vms"]["ref"]>) {
	const dir = await mkdtemp(join(tmpdir(), "ytimesy-job-worker-"));
	const archive = join(dir, "app.tgz");
	try {
		const packed = spawnSync(
			"tar",
			[
				"-czf",
				archive,
				"--exclude=node_modules",
				"--exclude=.git",
				"--exclude=.env",
				"--exclude=.secrets",
				"--exclude=.ytimesy",
				"src",
				"package.json",
				"pnpm-lock.yaml",
				"tsconfig.json",
			],
			{
				cwd: process.cwd(),
				stdio: "inherit",
				env: { ...process.env, COPYFILE_DISABLE: "1" },
			},
		);
		if (packed.status !== 0) throw new Error("Failed to pack the worker tree.");
		await run(
			vm,
			`mkdir -p ${JOB_WORKER_GUEST_ROOT}/.secrets && chown -R ubuntu:ubuntu ${JOB_WORKER_GUEST_ROOT}`,
			15_000,
			"root",
		);
		await vm.fs.writeFile(guestArchive, await openAsBlob(archive));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function deploySecrets(vm: ReturnType<Freestyle["vms"]["ref"]>) {
	const envSource = await readFile(".env", "utf8");
	const autoRefresh = process.env.YTIMESY_ENVIRONMENT_AUTO_REFRESH;
	if (autoRefresh && !["true", "false"].includes(autoRefresh))
		throw new Error("Environment auto-refresh must be true or false.");
	await vm.fs.writeTextFile(
		`${JOB_WORKER_GUEST_ROOT}/.env`,
		jobWorkerEnvFile(envSource, {
			cert: JOB_WORKER_GUEST_CERT,
			githubKey: JOB_WORKER_GUEST_GITHUB_KEY,
		}) +
			(autoRefresh
				? `\nYTIMESY_ENVIRONMENT_AUTO_REFRESH=${autoRefresh}\n`
				: ""),
	);
	const databaseUrl = process.env.DATABASE_URL ?? "";
	const certFromUrl = new URL(databaseUrl).searchParams.get("sslrootcert");
	const certPath = certFromUrl || ".secrets/supabase-ca.crt";
	await vm.fs.writeTextFile(
		JOB_WORKER_GUEST_CERT,
		await readFile(certPath, "utf8"),
	);
	const keyPath = process.env.GITHUB_PRIVATE_KEY_PATH?.trim();
	const key =
		process.env.GITHUB_PRIVATE_KEY?.replaceAll("\\n", "\n").trim() ||
		(keyPath ? await readFile(keyPath, "utf8") : "");
	if (key.includes("BEGIN")) {
		await vm.fs.writeTextFile(JOB_WORKER_GUEST_GITHUB_KEY, key);
	}
	await run(
		vm,
		`chown -R ubuntu:ubuntu ${JOB_WORKER_GUEST_ROOT} && chmod 600 ${JOB_WORKER_GUEST_ROOT}/.env ${JOB_WORKER_GUEST_CERT} ${JOB_WORKER_GUEST_GITHUB_KEY} 2>/dev/null || true`,
		15_000,
		"root",
	);
}

function guestStartScript() {
	return `#!/bin/bash
set -euo pipefail
export HOME=/home/ubuntu
export PATH="$HOME/.codex/packages/standalone/current:$HOME/.codex/bin:$HOME/.local/bin:$PATH"
export BUN_BINARY="$HOME/.local/share/ytimesy-bun/node_modules/.bin/bun"
if [ -s /usr/local/nvm/nvm.sh ]; then
  . /usr/local/nvm/nvm.sh
elif [ -s "$HOME/.nvm/nvm.sh" ]; then
  . "$HOME/.nvm/nvm.sh"
fi
set -a
. ${JOB_WORKER_GUEST_ROOT}/.env
set +a
cd ${JOB_WORKER_GUEST_ROOT}
exec node --import tsx src/server/jobs/worker.ts
`;
}

function guestBootstrapScript() {
	return `#!/bin/bash
set -euo pipefail
export HOME=/home/ubuntu
cd ${JOB_WORKER_GUEST_ROOT}
tar -xzf app.tgz || true
chmod 700 start.sh
if [ -s /usr/local/nvm/nvm.sh ]; then
  . /usr/local/nvm/nvm.sh
elif [ -s "$HOME/.nvm/nvm.sh" ]; then
  . "$HOME/.nvm/nvm.sh"
else
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  . "$HOME/.nvm/nvm.sh"
fi
command -v node >/dev/null || nvm install 22
corepack enable
corepack prepare pnpm@10.20.0 --activate
pnpm install --frozen-lockfile
if [ ! -x "$HOME/.local/share/ytimesy-bun/node_modules/.bin/bun" ] || [ "$("$HOME/.local/share/ytimesy-bun/node_modules/.bin/bun" --version)" != "${rigkitBunVersion}" ]; then
  npm install --prefix "$HOME/.local/share/ytimesy-bun" --no-save bun@${rigkitBunVersion}
fi
if ! command -v codex >/dev/null 2>&1 && [ ! -x "$HOME/.codex/packages/standalone/current/codex" ]; then
  ${pinnedCodexInstallCommand()}
fi
pkill -f 'src/server/jobs/worker.ts' || true
nohup ./start.sh >> ${guestLog} 2>&1 < /dev/null &
sleep 3
`;
}

async function run(
	vm: ReturnType<Freestyle["vms"]["ref"]>,
	command: string,
	timeoutMs: number,
	linuxUser?: string,
) {
	const result = await vm.exec({
		command: `bash -lc ${JSON.stringify(command)}`,
		timeoutMs,
		...(linuxUser ? { linuxUser } : {}),
	});
	if (result.statusCode !== 0) {
		throw new Error(
			`Guest command failed (${result.statusCode}): ${result.stderr || result.stdout}`,
		);
	}
	return result;
}

await main();
