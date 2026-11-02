import { detectEnvironment } from "./environment-detection";
import { posixShellQuoted as quote } from "./posix-command";

/**
 * A repository's installed dependencies, kept between builds of the same
 * person's same repository so a later build restores them instead of
 * installing again. Only the install a lockfile implies is cached (a custom
 * install command may do anything), only from a lockfile (an unlocked
 * install is not reproducible), and only where the install's effect is a
 * known set of directories.
 */
export type DependencyCacheSpec = {
	readonly stack:
		| "npm"
		| "pnpm"
		| "yarn"
		| "pip"
		| "uv"
		| "poetry"
		| "go"
		| "cargo";
	/** File names (anywhere in the checkout) whose contents decide the cache key. */
	readonly inputs: readonly string[];
	/** Bash run in the checkout that prints the absolute paths install produced, one per line. */
	readonly paths: string;
	/**
	 * After a restore: "skip" means the restore is the install; "install"
	 * runs the install anyway (it then finds everything in place).
	 */
	readonly afterRestore: "skip" | "install";
};

const NODE_INPUTS = [
	"package.json",
	".npmrc",
	".nvmrc",
	".node-version",
	"pnpm-workspace.yaml",
] as const;
const NODE_MODULES = `find "$PWD" \\( -name .git -o -name .venv \\) -prune -o -type d -name node_modules -prune -print`;

export function dependencyCacheSpec(
	files: readonly string[],
	install: string | undefined,
): DependencyCacheSpec | null {
	const detected = detectEnvironment(files);
	if (!install || install !== detected.install) return null;
	const has = (name: string) => files.includes(name);
	switch (detected.label) {
		case "Node (npm)":
			if (install !== "npm ci") return null;
			return {
				stack: "npm",
				inputs: [
					...NODE_INPUTS,
					has("npm-shrinkwrap.json")
						? "npm-shrinkwrap.json"
						: "package-lock.json",
				],
				paths: NODE_MODULES,
				afterRestore: "skip",
			};
		case "Node (pnpm)":
			return {
				stack: "pnpm",
				inputs: [...NODE_INPUTS, "pnpm-lock.yaml"],
				paths: NODE_MODULES,
				afterRestore: "skip",
			};
		case "Node (yarn)":
			return {
				stack: "yarn",
				inputs: [...NODE_INPUTS, "yarn.lock", ".yarnrc", ".yarnrc.yml"],
				paths: NODE_MODULES,
				afterRestore: "skip",
			};
		case "Python (pip)":
			return {
				stack: "pip",
				inputs: ["requirements.txt", ".python-version"],
				paths: `test -d "$PWD/.venv" && printf '%s\\n' "$PWD/.venv"`,
				afterRestore: "skip",
			};
		case "Python (uv)":
			return {
				stack: "uv",
				inputs: ["uv.lock", "pyproject.toml", ".python-version"],
				paths: `test -d "$PWD/.venv" && printf '%s\\n' "$PWD/.venv"`,
				afterRestore: "install",
			};
		case "Python (Poetry)":
			return {
				stack: "poetry",
				inputs: ["poetry.lock", "pyproject.toml", ".python-version"],
				paths: `d="$HOME/.cache/pypoetry/virtualenvs"; test -d "$d" && printf '%s\\n' "$d"`,
				afterRestore: "install",
			};
		case "Go":
			if (!has("go.sum")) return null;
			return {
				stack: "go",
				inputs: ["go.mod", "go.sum"],
				paths: `d=$(go env GOMODCACHE 2>/dev/null) && test -d "$d" && printf '%s\\n' "$d"`,
				afterRestore: "skip",
			};
		case "Rust":
			if (!has("Cargo.lock")) return null;
			return {
				stack: "cargo",
				inputs: [
					"Cargo.toml",
					"Cargo.lock",
					"rust-toolchain",
					"rust-toolchain.toml",
				],
				paths: `for d in "\${CARGO_HOME:-$HOME/.cargo}/registry" "\${CARGO_HOME:-$HOME/.cargo}/git"; do test -d "$d" && printf '%s\\n' "$d"; done`,
				afterRestore: "skip",
			};
		default:
			return null;
	}
}

/**
 * Bash run in the checkout: one line, the SHA-256 of every input file's
 * path and contents (dependency and build folders skipped), or "lifecycle"
 * for an npm project whose own install scripts may write outside
 * node_modules (`npm ci` would run them; a restore cannot).
 */
export function dependencyInputsHashCommand(
	directory: string,
	spec: DependencyCacheSpec,
) {
	const names = spec.inputs.map((name) => `-name ${quote(name)}`).join(" -o ");
	const lifecycle =
		spec.stack === "npm"
			? `if grep -Eq '"(preinstall|install|postinstall|prepare)"[[:space:]]*:' package.json; then echo lifecycle; exit 0; fi\n`
			: "";
	return `set -euo pipefail
cd ${quote(directory)}
${lifecycle}find . \\( -name node_modules -o -name .git -o -name .venv -o -name target \\) -prune -o -type f \\( ${names} \\) -print | LC_ALL=C sort | while IFS= read -r file; do printf '%s\\n' "$file"; sha256sum < "$file"; done | sha256sum | cut -d' ' -f1`;
}

/** Environment variable carrying a presigned object URL (never in a command's text). */
export const DEPENDENCY_CACHE_URL_VARIABLE = "YTIMESY_DEPENDENCY_CACHE_URL";
/** Where a background upload leaves its marker; removed before the template snapshot. */
export const DEPENDENCY_CACHE_ROOT = "/tmp/ytimesy-dependency-cache";
/** A cache larger than this is not uploaded. */
export const MAX_DEPENDENCY_CACHE_BYTES = 1024 * 1024 * 1024;

const CODEC = `if command -v zstd >/dev/null 2>&1; then pack='zstd -q -T0 -3'; unpack='zstd -q -d'; else pack='gzip -1'; unpack='gzip -dc'; fi`;

/**
 * Restores a cached archive into place. Exit 0: restored; 3: no archive
 * (a miss); anything else: it failed, and the install runs as usual.
 */
export function dependencyRestoreCommand() {
	return `set -uo pipefail
${CODEC}
archive=$(mktemp)
trap 'rm -f "$archive"' EXIT
status=$(curl -sS --max-time 300 -o "$archive" -w '%{http_code}' "$${DEPENDENCY_CACHE_URL_VARIABLE}") || exit 4
unset ${DEPENDENCY_CACHE_URL_VARIABLE}
[ "$status" = 404 ] && exit 3
[ "$status" = 200 ] || exit 4
$unpack < "$archive" | tar -C / -xf - || exit 5`;
}

/**
 * Starts the upload of what install produced in the background (the build
 * goes on; activation waits for it before the snapshot) and returns at once.
 * Credential and environment files are left out of the archive.
 */
export function dependencyUploadCommand(
	directory: string,
	spec: DependencyCacheSpec,
	id: string,
) {
	if (!/^[a-f0-9]{16,64}$/.test(id)) throw new Error("Invalid upload id.");
	const marker = `${DEPENDENCY_CACHE_ROOT}/${id}`;
	const upload = `set -uo pipefail
${CODEC}
cd -P ${quote(directory)} || exit 1
paths=$( { ${spec.paths}; } 2>/dev/null | sed 's|^/||')
[ -n "$paths" ] || exit 0
archive=$(mktemp)
trap 'rm -f "$archive"' EXIT
printf '%s\\n' "$paths" | tar -C / --exclude='.npmrc' --exclude='.env' --exclude='.env.*' -cf - -T - | $pack > "$archive" || exit 1
[ "$(wc -c < "$archive")" -le ${MAX_DEPENDENCY_CACHE_BYTES} ] || exit 0
curl -sS -f --max-time 600 -X PUT --upload-file "$archive" "$${DEPENDENCY_CACHE_URL_VARIABLE}" >/dev/null`;
	// Only the upload goes to the background, holding none of this command's
	// output: a backgrounded "mkdir && setsid ..." kept a subshell on it, and
	// the command returned only once the upload had finished.
	return `mkdir -p ${quote(DEPENDENCY_CACHE_ROOT)} || exit 1
setsid nohup bash -c ${quote(`${upload}\necho $? > ${quote(`${marker}.done`)}`)} </dev/null >/dev/null 2>&1 &
echo $! > ${quote(`${marker}.pid`)}
echo started`;
}

/**
 * Waits (bounded) for background uploads to finish, then stops any still
 * running and removes their markers: the template must not snapshot one.
 */
export function dependencyUploadsSettledCommand(waitSeconds: number) {
	const root = quote(DEPENDENCY_CACHE_ROOT);
	return `[ -d ${root} ] || exit 0
for i in $(seq 1 ${Math.max(1, Math.ceil(waitSeconds * 4))}); do
  pending=0
  for p in ${root}/*.pid; do [ -e "$p" ] || continue; [ -e "\${p%.pid}.done" ] || pending=1; done
  [ "$pending" = 0 ] && break
  sleep 0.25
done
for p in ${root}/*.pid; do
  [ -e "$p" ] || continue
  [ -e "\${p%.pid}.done" ] || kill -- "-$(cat "$p")" 2>/dev/null || true
done
rm -rf ${root}
true`;
}
