# Docker Hub rate-limits the shared VM IPs (429): pull through Google's mirror, Docker Hub as fallback.
mkdir -p /etc/docker && echo '{"registry-mirrors":["https://mirror.gcr.io"]}' > /etc/docker/daemon.json
systemctl restart docker 2>/dev/null || systemctl start docker 2>/dev/null || true
// Full verification of a commit on a Freestyle development VM instead of the
// laptop: install, typecheck, the full vitest suite and the offline
// rehearsal (scripts/rehearsal, which needs only Docker; the VM has it).
//
//   node --env-file=.env --import tsx scripts/remote-check.ts \
//     [--ref <git ref, default HEAD>] [--only typecheck,vitest,rehearsal] \
//     [--size large|xlarge] [--keep]
//
// Development only: refuses unless the database is the development project.
// The laptop side uses FREESTYLE_API_KEY (create/exec/delete the VM) and the
// development DATABASE_URL (read the workspace boot snapshot id). Nothing from
// .env reaches the VM: the suite runs on PGlite and the rehearsal on its own
// local Postgres container, so the VM gets only the non-secret variables in
// REMOTE_ENV. Logs go to .ytimesy/remote-check/<time>/.
import { execFileSync } from "node:child_process";
import {
	appendFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { WorkspaceId } from "../src/domain/ids";
import { MACHINE_SIZES } from "../src/domain/machine-size";
import { computeHourlyMicroUsd } from "../src/server/adapters/freestyle/usage-admission";
import { insertAgentSession } from "../src/server/adapters/agent-sessions";
import { sh, taskVms } from "./hard-set/vm";
import { createEvalUser, type EvalUser } from "./smoke/eval-user";

const DEVELOPMENT_REF = "exampledevprojectref";
const STEPS = ["typecheck", "vitest", "rehearsal"] as const;
type Step = (typeof STEPS)[number];
const TASK = "mvcc-lsm-compaction";
const DATASET =
	process.env.YTIMESY_REHEARSAL_DATASET ??
	"/path/to/cloud/.ytimesy/tb4-dataset";
const HOME = "/home/ubuntu";
const WORK = `${HOME}/rc`;
/** Everything the VM's steps see from us: no secrets (see the header). */
const REMOTE_ENV = {
	CI: "1",
	YTIMESY_REHEARSAL_DATASET: `${WORK}/dataset`,
};

const { values } = parseArgs({
	options: {
		ref: { type: "string", default: "HEAD" },
		only: { type: "string", default: STEPS.join(",") },
		size: { type: "string", default: "xlarge" },
		keep: { type: "boolean", default: false },
	},
});
const only = values.only.split(",").map((step) => step.trim()) as Step[];
for (const step of only)
	if (!STEPS.includes(step)) throw new Error(`Unknown step ${step}.`);
const sizeId = { large: "large", xlarge: "extra-large" }[values.size];
const size = MACHINE_SIZES.find((entry) => entry.id === sizeId);
if (!size) throw new Error("--size takes large or xlarge.");

const root = resolve(import.meta.dirname, "..");
// Development only, as scripts/verify-subscription-egress.ts checks it.
if (
	(await readFile(join(root, "supabase/.temp/project-ref"), "utf8")).trim() !==
		DEVELOPMENT_REF ||
	!new URL(process.env.DATABASE_URL ?? "").username.includes(DEVELOPMENT_REF)
)
	throw new Error("Not the approved development database; refusing.");
const apiKey = process.env.FREESTYLE_API_KEY;
if (!apiKey) throw new Error("FREESTYLE_API_KEY is not set.");

const git = (args: string[]) =>
	execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const sha = git(["rev-parse", "--verify", `${values.ref}^{commit}`]);
const nodeVersion = process.version;
const pnpmVersion = (
	JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
		packageManager: string;
	}
).packageManager.replace(/^pnpm@/, "");
const bunVersion = execFileSync("bun", ["--version"], {
	encoding: "utf8",
}).trim();

const started = Date.now();
const stamp = new Date().toISOString().replaceAll(":", "-");
const outDir = join(root, ".ytimesy/remote-check", stamp);
await mkdir(outDir, { recursive: true });
const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;
const say = (line: string) => {
	console.log(`remote-check [${elapsed()}] ${line}`);
	return appendFile(join(outDir, "progress.log"), `${line}\n`);
};

const vms = taskVms(apiKey);
const lifetimeSec = 3 * 3600;
let vm: string | undefined;
let vmStarted = 0;
const results: {
	step: string;
	ok: boolean;
	seconds: number;
	detail: string;
}[] = [];
const failingTests: string[] = [];
const failingChecks: string[] = [];

/** Runs a script on the VM detached, streaming its new log lines. */
async function step(name: string, script: string, timeoutSec: number) {
	if (!vm) throw new Error("No VM.");
	const id = vm;
	const local = join(outDir, `${name}.log`);
	await writeFile(local, "");
	const t0 = Date.now();
	await vms.startDetached(id, script, name);
	let offset = 0;
	let partial = "";
	const pull = async () => {
		const chunk = await vms.machines
			.exec(
				WorkspaceId(id),
				`tail -c +${offset + 1} /tb/${name}.log 2>/dev/null | head -c 262144`,
				30_000,
			)
			.catch(() => null);
		if (!chunk?.stdout) return;
		offset += Buffer.byteLength(chunk.stdout);
		await appendFile(local, chunk.stdout);
		const lines = (partial + chunk.stdout).split("\n");
		partial = lines.pop() ?? "";
		for (const line of lines)
			if (line.trim()) console.log(`  ${name} | ${line.slice(0, 220)}`);
	};
	const until = Date.now() + timeoutSec * 1000;
	let exit: number | undefined;
	while (exit === undefined) {
		await pull();
		const done = await vms.machines
			.exec(WorkspaceId(id), `cat /tb/${name}.exit 2>/dev/null`, 15_000)
			.catch(() => null);
		if (done?.stdout.trim()) exit = Number(done.stdout.trim());
		else if (Date.now() > until) exit = 124;
		else await new Promise((done) => setTimeout(done, 5000));
	}
	// Drain what is left (the log can be larger than one pull).
	for (let i = 0; i < 200; i++) {
		const before = offset;
		await pull();
		if (offset === before) break;
	}
	if (partial.trim()) console.log(`  ${name} | ${partial.slice(0, 220)}`);
	const seconds = Math.round((Date.now() - t0) / 1000);
	await say(
		`${name}: ${exit ? `FAILED (exit ${exit})` : "passed"} in ${seconds}s`,
	);
	return { exit, seconds, log: await readFile(local, "utf8") };
}

/** As the ubuntu user, in the checkout, with only REMOTE_ENV added. */
const asUbuntu = (command: string) =>
	`cd ${WORK}/repo && sudo -u ubuntu -H env ${Object.entries(REMOTE_ENV)
		.map(([key, value]) => `${key}=${sh(value)}`)
		.join(
			" ",
		)} PATH=/usr/local/bin:/usr/bin:/bin:${HOME}/.bun/bin bash -c ${sh(`set -o pipefail; ${command}`)}`;

let exitCode = 1;
// VM admission meters every VM against one owner: a throwaway eval user owns it.
let owner: EvalUser | undefined;
const scratch = await mkdtemp(join(tmpdir(), "remote-check-"));
const tempRef = `refs/remote-check/${process.pid}`;
try {
	const hourly = computeHourlyMicroUsd(size) / 1e6;
	await say(
		`ref ${values.ref} = ${sha}; steps ${only.join(",")}; VM ${size.name} (${size.cpu} vCPU / ${size.memory} MB) at $${hourly.toFixed(3)}/h; logs ${outDir}`,
	);
	await say(`VM env shipped: ${Object.keys(REMOTE_ENV).join(", ")}`);

	// The code: a bundle of the commit (its history included), cloned on the VM.
	const bundle = join(scratch, "repo.bundle");
	git(["update-ref", tempRef, sha]);
	try {
		git(["bundle", "create", bundle, tempRef]);
	} finally {
		git(["update-ref", "-d", tempRef]);
	}

	owner = await createEvalUser({ label: "remote-check" });
	const session = await insertAgentSession({
		userId: owner.userId,
		projectId: owner.project.projectId,
		workspaceId: owner.project.workspaceId,
		harness: "codex",
		title: `remote-check ${sha.slice(0, 8)}`,
	});
	const slug = `ytimesy-ag-${session.id.replaceAll("-", "").slice(0, 16)}`;
	const shape = await vms.createVm(
		slug,
		"remote-check",
		size.cpu,
		size.memory - 2048,
		lifetimeSec,
		(id) => {
			vm = id;
			vmStarted = Date.now();
			void owner?.trackVm(id);
		},
	);
	if (!vm) throw new Error("VM was not created.");
	await say(`VM ${vm} running (${shape})`);

	await vms.execOk(
		vm,
		`sudo mkdir -p ${WORK} && sudo chown ubuntu:ubuntu ${WORK}`,
		30_000,
	);
	await vms.uploadFile(vm, bundle, `${WORK}/repo.bundle`);
	if (only.includes("rehearsal"))
		await vms.uploadDirectory(
			vm,
			join(DATASET, TASK),
			`${WORK}/dataset/${TASK}`,
		);
	await say("code bundle and task files uploaded");

	// Toolchain as on the laptop: Node, pnpm from packageManager, Bun (one test runs it).
	const setup = await step(
		"setup",
		`set -euxo pipefail
exec 2>&1
cd ${WORK}
sudo -u ubuntu git init -q repo
sudo -u ubuntu git -C repo fetch -q ../repo.bundle "${tempRef}:refs/remote-check/head"
sudo -u ubuntu git -C repo checkout -q --detach ${sha}
arch=$(uname -m); case "$arch" in x86_64) narch=x64;; aarch64) narch=arm64;; esac
curl -fsSL https://nodejs.org/dist/${nodeVersion}/node-${nodeVersion}-linux-$narch.tar.xz | tar -xJ -C /usr/local --strip-components=1
npm install -g --force --loglevel=error pnpm@${pnpmVersion}
sudo -u ubuntu -H bash -c 'curl -fsSL https://bun.sh/install | bash -s bun-v${bunVersion}' >/dev/null
command -v docker >/dev/null || (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io >/dev/null)
# Docker Hub rate-limits the shared VM IPs (429): pull through Google's mirror, Docker Hub as fallback.
mkdir -p /etc/docker && echo '{"registry-mirrors":["https://mirror.gcr.io"]}' > /etc/docker/daemon.json
systemctl restart docker 2>/dev/null || systemctl start docker 2>/dev/null || true
usermod -aG docker ubuntu
for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 2; done
# The database image straight from the mirror, in case a pull skips it.
docker pull -q mirror.gcr.io/library/postgres:17-alpine && docker tag mirror.gcr.io/library/postgres:17-alpine postgres:17-alpine || true
# Nested Docker, as the rehearsal runs it: a privileged container with its own dockerd.
docker run --rm --privileged ubuntu:24.04 bash -c 'apt-get update -qq >/dev/null && apt-get install -y -qq docker.io >/dev/null && (dockerd >/tmp/d.log 2>&1 &) && for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done && docker run --rm hello-world >/dev/null && echo nested-docker-ok' || echo nested-docker-FAILED
echo "node $(node -v) pnpm $(pnpm -v) bun $(${HOME}/.bun/bin/bun --version) docker $(docker version -f '{{.Server.Version}}') cpus $(nproc) mem $(free -m | awk '/Mem/{print $2}')MB disk $(df -h / | awk 'NR==2{print $4}') free"`,
		1200,
	);
	results.push({
		step: "setup",
		ok: !setup.exit,
		seconds: setup.seconds,
		detail: /nested-docker-ok/.test(setup.log)
			? "nested docker ok"
			: "nested docker FAILED",
	});
	if (setup.exit) throw new Error("VM setup failed.");

	const install = await step(
		"install",
		asUbuntu("pnpm install --frozen-lockfile --reporter=append-only"),
		1500,
	);
	results.push({
		step: "install",
		ok: !install.exit,
		seconds: install.seconds,
		detail: "",
	});
	if (install.exit) throw new Error("Install failed.");

	if (only.includes("typecheck")) {
		const run = await step("typecheck", asUbuntu("pnpm typecheck"), 1500);
		const errors = run.log.match(/error TS\d+/g)?.length ?? 0;
		results.push({
			step: "typecheck",
			ok: !run.exit,
			seconds: run.seconds,
			detail: run.exit ? `${errors} TS error(s)` : "",
		});
	}

	if (only.includes("vitest")) {
		const run = await step(
			"vitest",
			asUbuntu(
				"pnpm vitest run --reporter=default --reporter=json --outputFile.json=/tb/vitest.json",
			),
			3600,
		);
		const json = await vms.machines.readTextFile(
			WorkspaceId(vm),
			"/tb/vitest.json",
		);
		let detail = "no JSON report";
		if (json) {
			await writeFile(join(outDir, "vitest.json"), json);
			const report = JSON.parse(json) as {
				numTotalTests: number;
				numPassedTests: number;
				numFailedTests: number;
				numPendingTests: number;
				numTodoTests: number;
				numTotalTestSuites: number;
				numFailedTestSuites: number;
				testResults: {
					name: string;
					status: string;
					message?: string;
					assertionResults: { fullName: string; status: string }[];
				}[];
			};
			for (const file of report.testResults) {
				const name = file.name.replace(`${WORK}/repo/`, "");
				const failed = file.assertionResults.filter(
					(test) => test.status === "failed",
				);
				for (const test of failed)
					failingTests.push(`${name} > ${test.fullName}`);
				if (file.status === "failed" && !failed.length)
					failingTests.push(
						`${name} (file failed: ${(file.message ?? "").split("\n")[0].slice(0, 160)})`,
					);
			}
			detail = `${report.numPassedTests} passed, ${report.numFailedTests} failed, ${report.numPendingTests + report.numTodoTests} skipped of ${report.numTotalTests} tests (${report.numTotalTestSuites} files, ${report.numFailedTestSuites} failed)`;
		}
		results.push({
			step: "vitest",
			ok: !run.exit,
			seconds: run.seconds,
			detail,
		});
	}

	if (only.includes("rehearsal")) {
		const run = await step("rehearsal", asUbuntu("pnpm rehearsal"), 3600);
		const ok = run.log.match(/^\s+ok\s{2}/gm)?.length ?? 0;
		for (const line of run.log.split("\n"))
			if (/^\s+FAIL /.test(line)) failingChecks.push(line.trim().slice(0, 300));
		// The per-scenario results, for a failing check's details.
		await vms
			.execOk(
				vm,
				`cd ${WORK}/repo && tar -czf /tb/rehearsal.tgz .ytimesy/rehearsal 2>/dev/null || true`,
				120_000,
			)
			.catch(() => {});
		await vms.client.vms
			.ref(vm)
			.fs.readFile("/tb/rehearsal.tgz")
			.then((data: Uint8Array) =>
				writeFile(join(outDir, "rehearsal.tgz"), data),
			)
			.catch(() => {});
		results.push({
			step: "rehearsal",
			ok: !run.exit,
			seconds: run.seconds,
			detail: `${ok} check(s) ok, ${failingChecks.length} failed`,
		});
	}
	exitCode = results.every((result) => result.ok) ? 0 : 1;
} catch (error) {
	await say(`error: ${(error as Error).message.slice(0, 800)}`);
} finally {
	await rm(scratch, { recursive: true, force: true });
	if (vm && !values.keep) {
		let deleted = false;
		for (let attempt = 0; attempt < 6 && !deleted; attempt++) {
			deleted = await vms.client.vms
				.delete(vm)
				.then(() => true)
				.catch((error: Error) => {
					console.log(
						`remote-check: VM delete failed: ${error.message}; retrying`,
					);
					return false;
				});
			if (!deleted) await new Promise((done) => setTimeout(done, 10_000));
		}
		console.log(
			`remote-check cleanup: VM ${vm} ${deleted ? "deleted" : "NOT deleted, delete it by hand"}`,
		);
	} else if (vm)
		console.log(
			`remote-check cleanup: VM ${vm} kept (--keep); it stops itself after ${lifetimeSec / 3600}h`,
		);
	else console.log("remote-check cleanup: no VM was created");
	if (owner) {
		const left = await owner.release().catch((error: Error) => [error.message]);
		console.log(
			`remote-check cleanup: eval user ${left.length ? `release left: ${left.join("; ")}` : "removed"}`,
		);
	}

	const vmHours = vmStarted ? (Date.now() - vmStarted) / 3_600_000 : 0;
	const cost = vmHours * (computeHourlyMicroUsd(size) / 1e6);
	const lines = [
		"",
		`remote-check summary: ${sha.slice(0, 12)} (${values.ref})`,
		...results.map(
			(result) =>
				`  ${result.ok ? "ok  " : "FAIL"} ${result.step} (${result.seconds}s)${result.detail ? `: ${result.detail}` : ""}`,
		),
		...(failingTests.length
			? ["  failing tests:", ...failingTests.map((test) => `    ${test}`)]
			: []),
		...(failingChecks.length
			? [
					"  failing rehearsal checks:",
					...failingChecks.map((check) => `    ${check}`),
				]
			: []),
		`  wall time ${elapsed()}; VM ${(vmHours * 60).toFixed(1)} min, est. $${cost.toFixed(3)} (compute at retail rate)`,
		`  ${exitCode ? "FAILED" : "all steps passed"}; logs ${outDir}`,
	];
	console.log(lines.join("\n"));
	await writeFile(join(outDir, "summary.txt"), `${lines.join("\n")}\n`);
	process.exit(exitCode);
}
