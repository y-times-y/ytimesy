import type { WorkspaceId } from "../../src/domain/ids";
import type { WorkspaceMachines } from "../../src/server/services/workspace-machines";

/**
 * The environment snapshot (harness variant envSnapshot=on, unattended
 * runs): before the root builder's first model request the bridge runs one
 * fixed, read-only probe in the task sandbox, through the same exec path as
 * tool commands, and puts what it found above the request. The probe is
 * generic for any Linux sandbox and names no task; every part tolerates a
 * missing tool, and a failed probe leaves the request unchanged.
 */

export const ENV_SNAPSHOT_HEADER =
	"Environment facts gathered by the harness before you started (verify anything critical):";

/** The probe's whole budget in the sandbox. */
export const ENV_SNAPSHOT_TIMEOUT_MS = 20_000;

/** The snapshot's text at most, header excluded. */
export const ENV_SNAPSHOT_MAX_CHARS = 3000;

const PRUNED = [
	".git",
	"node_modules",
	".venv",
	"venv",
	"env",
	"__pycache__",
	".cache",
	".mypy_cache",
	".pytest_cache",
	".ruff_cache",
	".tox",
	".next",
	"target",
	"dist",
	"build",
];

const MANIFESTS = [
	"README*",
	"AGENTS.md",
	"CLAUDE.md",
	"Makefile",
	"makefile",
	"GNUmakefile",
	"package.json",
	"pyproject.toml",
	"setup.py",
	"setup.cfg",
	"requirements*.txt",
	"Pipfile",
	"environment.yml",
	"Cargo.toml",
	"go.mod",
	"CMakeLists.txt",
	"meson.build",
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
	"Gemfile",
	"composer.json",
	"DESCRIPTION",
	"dune-project",
	"*.opam",
	"Dockerfile",
	"docker-compose.yml",
	"compose.yaml",
	"tox.ini",
	"pytest.ini",
	"tests",
	"test",
	"spec",
	"__tests__",
];

/** [name, version command] for common tools; missing ones are listed by name. */
const TOOLS: [string, string][] = [
	["python3", "python3 --version"],
	["pip", "pip --version"],
	["uv", "uv --version"],
	["node", "node --version"],
	["npm", "npm --version"],
	["gcc", "gcc --version"],
	["g++", "g++ --version"],
	["make", "make --version"],
	["cmake", "cmake --version"],
	["cargo", "cargo --version"],
	["go", "go version"],
	["java", "java -version"],
	["R", "R --version"],
	["ocaml", "ocaml -version"],
	["docker", "docker --version"],
];

/** The probe, a POSIX sh script run in the working directory. */
export function envSnapshotProbe(cwd: string): string {
	const q = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	const prune = PRUNED.map((name) => `-name ${q(name)}`).join(" -o ");
	return [
		`cd ${q(cwd)} 2>/dev/null || true`,
		// Bounded steps where timeout(1) exists.
		`t() { if command -v timeout >/dev/null 2>&1; then timeout "$@"; else shift; "$@"; fi; }`,
		`echo "## System"`,
		`os=$( (. /etc/os-release && echo "$PRETTY_NAME") 2>/dev/null )`,
		`echo "os: \${os:-unknown} ($(uname -m 2>/dev/null))"`,
		`echo "cpus: $(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo unknown)"`,
		`[ -r /proc/meminfo ] && awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{printf "memory: %.1f GB total, %.1f GB available\\n", t/1048576, a/1048576}' /proc/meminfo`,
		`echo "disk free here: $(df -h . 2>/dev/null | awk 'NR==2{print $4}')"`,
		`echo "user: $(id -un 2>/dev/null || echo unknown)"`,
		`echo "cwd: $(pwd)"`,
		`echo`,
		`echo "## Files (depth 2; ${PRUNED.slice(0, 4).join(", ")}, caches and build output not expanded)"`,
		`files=$(t 5 find . -mindepth 1 -maxdepth 2 \\( ${prune} \\) -prune -print -o -print 2>/dev/null | sort)`,
		`n=$(printf '%s\\n' "$files" | grep -c .)`,
		`printf '%s\\n' "$files" | head -n 80 | while IFS= read -r p; do if [ -d "$p" ]; then echo "\${p#./}/"; else echo "\${p#./}"; fi; done`,
		`[ "$n" -gt 80 ] && echo "... $((n - 80)) more entries"`,
		`[ "$n" -eq 0 ] && echo "(empty)"`,
		`echo`,
		`echo "## Project files"`,
		`found=""; for f in ${MANIFESTS.join(" ")}; do [ -e "$f" ] && found="$found $f"; done`,
		`echo "present:\${found:- none}"`,
		`if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then`,
		`  echo "git: branch $(git rev-parse --abbrev-ref HEAD 2>/dev/null), $(git status --porcelain 2>/dev/null | grep -c .) changed paths, last commit: $(git log -1 --format='%h %s' 2>/dev/null | cut -c1-80)"`,
		`else echo "git: not a repository"; fi`,
		`echo`,
		`echo "## Tools"`,
		`missing=""`,
		...TOOLS.map(
			([name, command]) =>
				`if command -v ${q(name)} >/dev/null 2>&1; then echo "${name}: $(t 3 ${command} 2>&1 | head -n 1 | cut -c1-100)"; else missing="$missing ${name}"; fi`,
		),
		`echo "missing:\${missing:- none}"`,
		`echo`,
		`echo "## Network"`,
		// One bounded connect to a public host (DNS + TCP 443).
		`if command -v curl >/dev/null 2>&1; then t 4 curl -sS -m 3 -o /dev/null https://pypi.org/ >/dev/null 2>&1 && net=ok || net=failed`,
		`elif command -v python3 >/dev/null 2>&1; then t 4 python3 -c 'import socket; socket.create_connection(("pypi.org", 443), 3)' >/dev/null 2>&1 && net=ok || net=failed`,
		`elif command -v wget >/dev/null 2>&1; then t 4 wget -q -T 3 -O /dev/null https://pypi.org/ >/dev/null 2>&1 && net=ok || net=failed`,
		`else net="unknown (no curl, python3 or wget)"; fi`,
		`echo "egress (https to pypi.org, 3s): $net"`,
		`echo`,
		`echo "## Processes and ports"`,
		// Everything but this probe, shells, sleeps and the harness's own tmux.
		`procs=$(for d in /proc/[0-9]*; do pid=\${d#/proc/}; [ "$pid" = "$$" ] && continue; c=$(tr '\\0' ' ' < "$d/cmdline" 2>/dev/null | cut -c1-100); [ -n "$c" ] && echo "$pid $c"; done 2>/dev/null | grep -Ev '^[0-9]+ (/[^ ]*/)?(sh|bash|dash|zsh|sleep|tmux|timeout|find|sort|grep|awk|head|cut|tr|cat|ps|tail)( |$)' | head -n 12)`,
		`echo "processes:"; printf '%s\\n' "\${procs:-none}" | sed 's/^/  /'`,
		`ports=""; for f in /proc/net/tcp /proc/net/tcp6; do [ -r "$f" ] || continue; for h in $(awk 'NR>1 && $4=="0A"{split($2,a,":"); print a[2]}' "$f"); do ports="$ports $(printf '%d' "0x$h")"; done; done`,
		`list=$(printf '%s\\n' $ports | sort -un | tr '\\n' ' ' | sed 's/ *$//')`,
		`echo "listening tcp ports: \${list:-none}"`,
		`true`,
	].join("\n");
}

/** Caps the probe's output; a cut is said so. */
export function envSnapshotText(output: string): string | null {
	const text = output.trim();
	if (!text) return null;
	const body =
		text.length > ENV_SNAPSHOT_MAX_CHARS
			? `${text.slice(0, ENV_SNAPSHOT_MAX_CHARS)}\n[snapshot cut at ${ENV_SNAPSHOT_MAX_CHARS} of ${text.length} chars]`
			: text;
	return `${ENV_SNAPSHOT_HEADER}\n${body}`;
}

/** Runs the probe; null when it fails or finds nothing. */
export async function envSnapshot(input: {
	machines: WorkspaceMachines;
	vm: WorkspaceId;
	cwd: string;
}): Promise<string | null> {
	try {
		const result = await input.machines.exec(
			input.vm,
			envSnapshotProbe(input.cwd),
			ENV_SNAPSHOT_TIMEOUT_MS,
		);
		return envSnapshotText(result.stdout);
	} catch {
		return null;
	}
}
