// How a Terminal-Bench task's environment is reproduced on one development
// workspace VM, and how its own tests grade the result (docs/hard-set.md).
//
// The VM keeps being the builder's workspace: the harness's file tools, git
// turn commits and helpers run on the VM as `ubuntu`. The task runs in Docker
// on the same VM, from the task's pinned images (Docker Compose for tasks with
// service sidecars). The task's working directory and the other task
// directories its artifacts live in are bind-mounted between the VM and the
// task container at the same paths, and `~/<project>` on the VM links to the
// working directory, so the builder's project is the task's directory. Every
// builder command (the runtime wraps each in `bash -lc` behind the
// agent-secrets prefix) is re-executed inside the task container by a
// /etc/profile.d hook, in the same directory, with its process group stopped
// when the command ends or is cancelled. Grading follows Harbor's separate
// verifier on a second VM that never runs the agent: collect commands and
// artifacts copied out on the agent VM; on the grader VM the verifier image
// started, artifacts copied in at the same paths, `/tests/test.sh`, then
// reward.json or reward.txt.
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { SOURCE_AGENT_SECRETS } from "../../src/domain/project-secret";

export type Artifact = {
	source: string;
	service: string;
	exclude: string[];
};

export type TaskEnvironment = {
	id: string;
	dir: string;
	instruction: string;
	envImage: string;
	verifierImage: string;
	/** Compose file (main plus sidecars), main without its command. */
	compose: { services: Record<string, Record<string, unknown>> };
	sidecars: string[];
	cpus: number;
	memoryMb: number;
	storageMb: number;
	verifierCpus: number;
	verifierMemoryMb: number;
	verifierTimeoutSec: number;
	verifierEnv: Record<string, string>;
	solutionEnv: Record<string, string>;
	collect: { command: string; service: string }[];
	artifacts: Artifact[];
	gpus: number;
	mcpServers: number;
};

const SYSTEM_TOP_DIRS = new Set([
	"bin",
	"boot",
	"dev",
	"etc",
	"home",
	"lib",
	"lib32",
	"lib64",
	"opt",
	"proc",
	"root",
	"run",
	"sbin",
	"srv",
	"sys",
	"tmp",
	"usr",
	"var",
	"logs",
	"tests",
	"solution",
	"tb",
]);

/** Reads task.toml with Python's tomllib (isolated mode); no tests or solution files are read. */
function readToml(path: string): Record<string, unknown> {
	return JSON.parse(
		execFileSync(
			"python3",
			[
				"-I",
				"-c",
				"import json,sys,tomllib; print(json.dumps(tomllib.load(open(sys.argv[1],'rb'))))",
				path,
			],
			{ encoding: "utf8" },
		),
	);
}

const stringRecord = (value: unknown): Record<string, string> =>
	Object.fromEntries(
		Object.entries((value ?? {}) as Record<string, unknown>).map(([k, v]) => [
			k,
			String(v),
		]),
	);

export async function loadTaskEnvironment(
	dataset: string,
	id: string,
): Promise<TaskEnvironment> {
	const dir = join(dataset, id);
	const config = readToml(join(dir, "task.toml")) as Record<
		string,
		Record<string, unknown>
	>;
	const environment = config.environment as Record<string, unknown>;
	const verifier = config.verifier as Record<string, unknown>;
	const verifierEnvironment = (verifier.environment ?? {}) as Record<
		string,
		unknown
	>;
	if (verifier.environment_mode !== "separate")
		throw new Error(
			`${id}: only separate verifier environments are supported.`,
		);
	const instruction = (await readFile(join(dir, "instruction.md"), "utf8"))
		.split("\n")
		.filter((line) => !/canary GUID/i.test(line))
		.join("\n")
		.trim();
	let compose: { services: Record<string, Record<string, unknown>> };
	try {
		compose = parse(
			await readFile(join(dir, "environment", "docker-compose.yaml"), "utf8"),
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		compose = { services: { main: {} } };
	}
	const envImage = String(environment.docker_image);
	compose.services.main = { ...compose.services.main, image: envImage };
	for (const [name, service] of Object.entries(compose.services)) {
		if (service.build)
			throw new Error(`${id}: service ${name} builds an image; unsupported.`);
		if (!service.image)
			throw new Error(`${id}: service ${name} has no image; unsupported.`);
	}
	const artifacts = ((config.artifacts ?? []) as unknown as unknown[]).map(
		(entry) =>
			typeof entry === "string"
				? { source: entry, service: "main", exclude: [] }
				: {
						source: String((entry as Record<string, unknown>).source),
						service: String(
							(entry as Record<string, unknown>).service ?? "main",
						),
						exclude: ((entry as Record<string, unknown>).exclude ??
							[]) as string[],
					},
	);
	const collect = ((verifier.collect ?? []) as Record<string, unknown>[]).map(
		(step) => ({
			command: String(step.command),
			service: String(step.service ?? "main"),
		}),
	);
	return {
		id,
		dir,
		instruction,
		envImage,
		verifierImage: String(verifierEnvironment.docker_image),
		compose,
		sidecars: Object.keys(compose.services).filter((name) => name !== "main"),
		cpus: Number(environment.cpus ?? 2),
		memoryMb: Number(environment.memory_mb ?? 4096),
		storageMb: Number(environment.storage_mb ?? 10240),
		verifierCpus: Number(verifierEnvironment.cpus ?? 2),
		verifierMemoryMb: Number(verifierEnvironment.memory_mb ?? 4096),
		verifierTimeoutSec: Number(verifier.timeout_sec ?? 600),
		verifierEnv: {
			...stringRecord(verifierEnvironment.env),
			...stringRecord(verifier.env),
		},
		solutionEnv: stringRecord(
			(config.solution as Record<string, unknown> | undefined)?.env,
		),
		collect,
		artifacts,
		gpus: Number(environment.gpus ?? 0),
		mcpServers: ((environment.mcp_servers ?? []) as unknown[]).length,
	};
}

/** Top-level task directories (besides the working directory's) to share with the VM. */
export function extraMounts(task: TaskEnvironment) {
	const tops = new Set<string>();
	for (const artifact of task.artifacts) {
		if (artifact.service !== "main") continue;
		const top = artifact.source.split("/").filter(Boolean)[0];
		if (top && !SYSTEM_TOP_DIRS.has(top)) tops.add(`/${top}`);
	}
	return [...tops];
}

const q = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** VM-side files for the setup step; `name` is the builder project's folder under ~. */
export function setupFiles(task: TaskEnvironment, name: string) {
	if (!/^[A-Za-z0-9._-]+$/.test(name))
		throw new Error("Unexpected project folder name.");
	const config = [
		`ENV_IMAGE=${q(task.envImage)}`,
		`VER_IMAGE=${q(task.verifierImage)}`,
		`NAME=${q(name)}`,
		`EXTRA_MOUNTS=${q(extraMounts(task).join(" "))}`,
		`SIDECARS=${task.sidecars.length}`,
	].join("\n");
	return {
		"/tb/config.sh": `${config}\n`,
		"/tb/compose.json": JSON.stringify(task.compose),
		"/tb/route-prefix": SOURCE_AGENT_SECRETS,
		"/tb/setup.sh": SETUP_SCRIPT,
		"/tb/tb-route": ROUTE_SCRIPT,
		"/tb/zz-tb-route.sh": PROFILE_HOOK,
	};
}

/**
 * Runs as root on the VM. Pulls the images, copies the task directories out
 * of the environment image, prepares the project like the TB4 bridge did
 * (git baseline; git, python3 and ripgrep in the task container when
 * missing), starts the environment and installs the command route. Ends with
 * a self-test that a routed builder command runs inside the container.
 */
const SETUP_SCRIPT = String.raw`#!/bin/bash
set -euo pipefail
cd /tb
source /tb/config.sh
t0=$(date +%s)
log() { echo "[setup +$(( $(date +%s) - t0 ))s] $*"; }
export DEBIAN_FRONTEND=noninteractive
# Resized CPUs appear after start; dockerd counts CPUs only when it starts.
systemctl restart docker
for _ in $(seq 60); do docker info >/dev/null 2>&1 && break; sleep 1; done
need=""
command -v setfacl >/dev/null || need="$need acl"
docker compose version >/dev/null 2>&1 || need="$need docker-compose-v2"
if [ -n "$need" ]; then apt-get update -qq && apt-get install -y -qq $need >/dev/null; fi
log "docker ready: $(docker info -f '{{.NCPU}}') cpus, $(nproc) online"
docker compose -p tb -f /tb/compose.json pull -q
log "environment images pulled"
WD=$(docker image inspect -f '{{.Config.WorkingDir}}' "$ENV_IMAGE")
if [ -z "$WD" ] || [ "$WD" = / ]; then WD=/app; fi
top="/$(echo "$WD" | cut -d/ -f2)"
MOUNTS=$(printf '%s\n' "$top" $EXTRA_MOUNTS | sort -u | tr '\n' ' ')
cid=$(docker create --entrypoint sh "$ENV_IMAGE")
for d in $MOUNTS; do
  rm -rf "$d"; mkdir -p "$d"
  docker cp "$cid:$d/." "$d/" 2>/dev/null || true
done
docker rm -f "$cid" >/dev/null
mkdir -p "$WD"
chown -R 1000:1000 $MOUNTS
# The VM user (builder file tools, git) and the container user (commands)
# both keep write access to everything either of them creates.
setfacl -R -m u:1000:rwX,d:u:1000:rwX,m:rwX,d:m:rwX $MOUNTS
log "task directories copied: $MOUNTS (working directory $WD)"
git config --system --add safe.directory '*'
cd "$WD"
if [ ! -d .git ]; then
  sudo -u ubuntu git init -q
  sudo -u ubuntu git symbolic-ref HEAD refs/heads/evaluation-frozen
  sudo -u ubuntu git config user.name 'Evaluation fixture'
  sudo -u ubuntu git config user.email 'evaluation@ytimesy.invalid'
  printf '\nnode_modules/\n.next/\n.ytimesy/\n__pycache__/\n' >> .git/info/exclude
  sudo -u ubuntu git add -A
  sudo -u ubuntu git commit -q --allow-empty -m 'Frozen benchmark environment'
fi
sudo -u ubuntu git update-ref refs/ytimesy/base HEAD
cd /tb
log "git baseline ready"
mkdir -p /home/ubuntu/.ytimesy /tb/route
chown ubuntu:ubuntu /home/ubuntu/.ytimesy
chmod 0777 /tb/route
sudo -u ubuntu ln -sfn "$WD" "/home/ubuntu/$NAME"
{
  echo "services:"
  echo "  main:"
  echo "    container_name: tb"
  echo '    command: ["sh", "-c", "sleep infinity"]'
  # Without sidecars the container shares the VM's network, so the VM-side
  # browser helper reaches servers the agent starts; with sidecars it keeps
  # Compose's network and service names.
  if [ "$SIDECARS" = 0 ]; then echo "    network_mode: host"; fi
  echo "    volumes:"
  echo "      - /home/ubuntu/.ytimesy:/home/ubuntu/.ytimesy:ro"
  echo "      - /tb/route:/tb/route"
  for d in $MOUNTS; do echo "      - $d:$d"; done
} > /tb/override.yaml
docker compose -p tb -f /tb/compose.json -f /tb/override.yaml up -d --wait --wait-timeout 240 >/tb/compose-up.log 2>&1 || { cat /tb/compose-up.log; exit 1; }
log "environment started"
docker exec -u 0 -e WD="$WD" -e NAME="$NAME" tb sh -c '
  mkdir -p /home/ubuntu && ln -sfn "$WD" "/home/ubuntu/$NAME"
  echo "export PATH=\"\$PATH:/home/ubuntu/.ytimesy/bin\"" > /etc/profile.d/zz-ytimesy.sh
  missing=""
  for c in git python3 rg; do command -v $c >/dev/null 2>&1 || missing="$missing $c"; done
  if [ -n "$missing" ]; then
    if command -v apt-get >/dev/null; then
      apt-get update -qq >/dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git python3 ripgrep >/dev/null 2>&1 || true
    elif command -v dnf >/dev/null; then dnf install -y -q git python3 ripgrep >/dev/null 2>&1 || true
    elif command -v apk >/dev/null; then apk add -q git python3 ripgrep bash >/dev/null 2>&1 || true
    fi
  fi
  git config --system --add safe.directory "*" 2>/dev/null || true
  command -v setsid >/dev/null && setsid --help 2>&1 | grep -q -- "--wait" && echo setsid-wait > /tb/route/.setsid || true
  echo "container: $(id -u) $(command -v bash) git=$(command -v git) python3=$(command -v python3) rg=$(command -v rg)"
'
cuid=$(docker exec tb id -u)
if [ "$cuid" != 0 ] && [ "$cuid" != 1000 ]; then
  setfacl -R -m u:$cuid:rwX,d:u:$cuid:rwX $MOUNTS
fi
printf '%s\n' $MOUNTS > /tb/route-mounts
printf 'WD=%q\nMOUNTS=%q\n' "$WD" "$MOUNTS" > /tb/runtime.sh
install -m 755 /tb/tb-route /usr/local/bin/tb-route
install -m 644 /tb/zz-tb-route.sh /etc/profile.d/zz-tb-route.sh
printf '%s\n' "/home/ubuntu/$NAME" > /tmp/ytimesy-project-cwd
chown ubuntu:ubuntu /tmp/ytimesy-project-cwd
# Self-test: a builder-shaped command from the project runs in the container.
probe=$(cd "/home/ubuntu/$NAME" && sudo -u ubuntu bash -lc "$(cat /tb/route-prefix)
echo routed:\$(test -e /.dockerenv && echo container):\$(pwd -P)")
expected="routed:container:$WD"
if [ "$probe" = "$expected" ]; then log "route self-test ok ($probe)"; else echo "route self-test failed: got '$probe', expected '$expected'"; exit 1; fi
echo "$WD" > /tb/workdir
log "setup done"
`;

/** VM side of a routed builder command: argv cwd, command text. */
const ROUTE_SCRIPT = String.raw`#!/bin/bash
cwd=$1
id="$(date +%s%N)-$$"
printf '%s' "$2" > "/tb/route/$id.sh"
if [ -f /tb/route/.setsid ]; then
  inner="umask 0002; exec setsid --wait bash -c 'echo \$\$ > /tb/route/$id.pid; exec bash -l /tb/route/$id.sh'"
else
  inner="umask 0002; echo \$\$ > /tb/route/$id.pid; exec bash -l /tb/route/$id.sh"
fi
docker exec -w "$cwd" -e NO_COLOR=1 -e TERM=dumb tb bash -c "$inner" &
child=$!
# Signals the command's process group in the container; "clean" also removes
# its pid file (written by the container's user, so removed from there).
stop_group() {
  docker exec tb sh -c "p=/tb/route/$id.pid; if [ -s \$p ]; then kill -$1 -- -\$(cat \$p) 2>/dev/null || kill -$1 \$(cat \$p) 2>/dev/null; fi; [ '$2' = clean ] && rm -f \$p; true" >/dev/null 2>&1
}
trap 'stop_group TERM; sleep 1; stop_group KILL clean; kill $child 2>/dev/null; rm -f "/tb/route/$id.sh" 2>/dev/null; exit 143' TERM HUP INT
wait $child
rc=$?
# As on the VM, a command's leftover process group ends with it.
stop_group KILL clean
rm -f "/tb/route/$id.sh" 2>/dev/null
exit $rc
`;

/**
 * Login-shell hook on the VM: a builder command (the runtime's agent-secrets
 * prefix) started in a shared task directory runs in the task container.
 * `ytimesy-job` and `ytimesy-browser` alone stay on the VM, where their
 * tmux sessions and browser live.
 */
const PROFILE_HOOK = [
	// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
	'if [ -n "${BASH_VERSION:-}" ] && [ -n "${BASH_EXECUTION_STRING:-}" ] && [ -r /tb/route-prefix ] && [ -r /tb/route-mounts ]; then',
	"  __tb_prefix=$(cat /tb/route-prefix)",
	'  if [[ "$BASH_EXECUTION_STRING" == "$__tb_prefix"* ]]; then',
	// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
	'    __tb_rest=${BASH_EXECUTION_STRING#"$__tb_prefix"}',
	"    __tb_cwd=$(pwd -P)",
	'    __tb_route=""',
	"    while IFS= read -r __tb_m; do",
	'      [ -n "$__tb_m" ] || continue',
	'      case "$__tb_cwd/" in "$__tb_m"/*) __tb_route=1 ;; esac',
	"    done < /tb/route-mounts",
	"    __tb_re='^[[:space:]]*ytimesy-(job|browser)([[:space:]][^;&|$`<>()]*)?[[:space:]]*$'",
	'    if [[ "$__tb_rest" =~ $__tb_re ]]; then __tb_route=""; fi',
	'    if [ -n "$__tb_route" ]; then exec /usr/local/bin/tb-route "$__tb_cwd" "$BASH_EXECUTION_STRING"; fi',
	"    unset __tb_rest __tb_cwd __tb_route __tb_m __tb_re",
	"  fi",
	"  unset __tb_prefix",
	"fi",
	"",
].join("\n");

/**
 * Runs as root on the agent VM after the turn, like Harbor's separate
 * verifier: collect commands, then each artifact copied out of its service
 * into /tb/artifacts/<index>/ and packed into /tb/artifacts.tgz.
 */
export function stageScript(task: TaskEnvironment) {
	const lines = [
		"#!/bin/bash",
		"set -uo pipefail",
		"rm -rf /tb/artifacts /tb/artifacts.tgz; mkdir -p /tb/artifacts",
		'cid() { if [ "$1" = main ]; then echo tb; else docker compose -p tb -f /tb/compose.json -f /tb/override.yaml ps -q "$1"; fi; }',
	];
	for (const step of task.collect)
		lines.push(
			`docker exec -u 0 "$(cid ${q(step.service)})" bash -c ${q(step.command)} || echo "collect step failed"`,
		);
	task.artifacts.forEach((artifact, index) => {
		const source = artifact.source.replace(/\/+$/, "") || "/";
		const excludes = artifact.exclude
			.map((pattern) => `--exclude=${q(pattern.replace(/^\.\//, ""))}`)
			.join(" ");
		lines.push(
			`mkdir -p /tb/artifacts/${index}`,
			`docker cp "$(cid ${q(artifact.service)}):${source}" - 2>/dev/null | tar -x -C /tb/artifacts/${index} ${excludes} || echo ${q(`artifact unavailable: ${artifact.source}`)}`,
		);
	});
	lines.push(
		"tar -czf /tb/artifacts.tgz -C /tb/artifacts .",
		'echo "STAGED $(du -sk /tb/artifacts | cut -f1) KB"',
	);
	return `${lines.join("\n")}\n`;
}

/** Runs as root on a grader VM: pulls the verifier image (started at task start). */
export function graderPullScript(task: TaskEnvironment) {
	return [
		"#!/bin/bash",
		"systemctl restart docker",
		"for _ in $(seq 60); do docker info >/dev/null 2>&1 && break; sleep 1; done",
		`docker pull -q ${q(task.verifierImage)}`,
		"",
	].join("\n");
}

/**
 * Runs as root on the grader VM once /tb/artifacts.tgz (and /tb/tests when
 * the verifier image has none) are there: the verifier container gets the
 * artifacts at their original paths, then `/tests/test.sh` runs.
 */
export function verifyScript(task: TaskEnvironment, timeoutSec: number) {
	const lines = [
		"#!/bin/bash",
		"set -uo pipefail",
		"t0=$(date +%s)",
		'log() { echo "[grade +$(( $(date +%s) - t0 ))s] $*"; }',
		"rm -rf /tb/artifacts /tb/verifier-out; mkdir -p /tb/artifacts /tb/verifier-out",
		"tar -xzf /tb/artifacts.tgz -C /tb/artifacts",
		"for _ in $(seq 280); do [ -f /tb/pull.exit ] && break; sleep 1; done",
		'[ "$(cat /tb/pull.exit 2>/dev/null)" = 0 ] || { tail -c 600 /tb/pull.log; echo "GRADE_ERROR verifier image pull failed"; exit 0; }',
		`docker rm -f tbv >/dev/null 2>&1; docker run -d --name tbv ${Object.entries(
			task.verifierEnv,
		)
			.map(([key, value]) => `-e ${q(`${key}=${value}`)}`)
			.join(
				" ",
			)} ${q(task.verifierImage)} sh -c 'sleep infinity' >/dev/null || { echo "GRADE_ERROR verifier did not start"; exit 0; }`,
	];
	task.artifacts.forEach((artifact, index) => {
		const source = artifact.source.replace(/\/+$/, "") || "/";
		const base = source.split("/").at(-1) as string;
		const parent = source.slice(0, source.lastIndexOf("/")) || "/";
		lines.push(
			`if [ -d /tb/artifacts/${index}/${q(base)} ]; then docker exec -u 0 tbv mkdir -p ${q(source)} && docker cp /tb/artifacts/${index}/${q(base)}/. tbv:${q(source)}; elif [ -e /tb/artifacts/${index}/${q(base)} ]; then docker exec -u 0 tbv mkdir -p ${q(parent)} && docker cp /tb/artifacts/${index}/${q(base)} tbv:${q(source)}; else log ${q(`no artifact ${artifact.source}`)}; fi`,
		);
	});
	lines.push(
		// The verifier image usually carries /tests; otherwise the task's are uploaded.
		"if ! docker exec tbv test -f /tests/test.sh; then docker exec -u 0 tbv mkdir -p /tests && docker cp /tb/tests/. tbv:/tests; fi",
		"docker exec -u 0 tbv sh -c 'mkdir -p /logs/verifier /logs/agent && chmod 777 /logs/verifier /logs/agent'",
		'log "verifier ready"',
		`timeout ${Math.max(30, Math.floor(timeoutSec))} docker exec tbv bash -c 'chmod +x /tests/test.sh 2>/dev/null; bash /tests/test.sh > /logs/verifier/test-stdout.txt 2>&1'`,
		"rc=$?",
		'log "tests exited $rc"',
		"docker cp tbv:/logs/verifier/. /tb/verifier-out/ >/dev/null 2>&1",
		"docker rm -f tbv >/dev/null 2>&1",
		'echo "TESTS_EXIT=$rc"',
		'if [ -f /tb/verifier-out/reward.json ]; then echo "REWARD_JSON=$(tr -d "\\n" < /tb/verifier-out/reward.json)"; fi',
		'if [ -f /tb/verifier-out/reward.txt ]; then echo "REWARD_TXT=$(tr -d "\\n" < /tb/verifier-out/reward.txt)"; fi',
		'echo "TESTS_TAIL_BEGIN"; tail -c 1500 /tb/verifier-out/test-stdout.txt 2>/dev/null; echo; echo "TESTS_TAIL_END"',
	);
	return `${lines.join("\n")}\n`;
}

/** Oracle preflight: the task's reference solution, run in the task container. */
export function oracleScript(task: TaskEnvironment, timeoutSec: number) {
	const env = Object.entries(task.solutionEnv)
		.map(([key, value]) => `-e ${q(`${key}=${value}`)}`)
		.join(" ");
	return [
		"#!/bin/bash",
		"set -uo pipefail",
		"source /tb/runtime.sh",
		"docker exec -u 0 tb mkdir -p /solution && docker cp /tb/solution/. tb:/solution",
		`timeout ${Math.floor(timeoutSec)} docker exec ${env} -w "$WD" tb bash -c 'chmod +x /solution/solve.sh; bash /solution/solve.sh'`,
		'echo "ORACLE_EXIT=$?"',
		"docker exec -u 0 tb rm -rf /solution",
		"",
	].join("\n");
}

/** Reward from the grade script's output: reward.json's `reward` wins over reward.txt. */
export function parseReward(output: string): {
	reward: number | null;
	testsExit: number | null;
	error: string | null;
	tail: string;
} {
	const error = /GRADE_ERROR (.*)/.exec(output)?.[1] ?? null;
	const testsExit = /TESTS_EXIT=(\d+)/.exec(output);
	const tail =
		/TESTS_TAIL_BEGIN\n([\s\S]*?)\nTESTS_TAIL_END/.exec(output)?.[1] ?? "";
	let reward: number | null = null;
	const json = /REWARD_JSON=(.*)/.exec(output)?.[1];
	if (json)
		try {
			const value = Number(JSON.parse(json)?.reward);
			if (Number.isFinite(value)) reward = value;
		} catch {}
	if (reward === null) {
		const text = /REWARD_TXT=(.*)/.exec(output)?.[1];
		const value = text === undefined ? Number.NaN : Number(text.trim());
		if (Number.isFinite(value)) reward = value;
	}
	return {
		reward,
		testsExit: testsExit ? Number(testsExit[1]) : null,
		error,
		tail,
	};
}
