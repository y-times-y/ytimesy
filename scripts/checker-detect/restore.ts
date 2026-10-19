// Restores a finished run's saved workspace into a fresh task environment for
// the checker detection test (docs/checker-detect.md). The environment comes
// from scripts/hard-set/environment.ts (task images, working directory copied
// out of the image, command route into the container); this adds the saved
// artifacts on top, exactly as Harbor's separate verifier received them, so
// the checker sees what the grader graded: each artifact at its own path in
// its own service, and a diff artifact (`/tmp/agent.patch` made by a
// `git diff` collect step) applied to the working directory.
import {
	type Artifact,
	type TaskEnvironment,
	UNREADABLE_KEEP_MODE,
} from "../hard-set/environment";

const q = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** macOS tar's AppleDouble metadata entries: never part of an artifact. */
export const APPLEDOUBLE = "._*";

export const isAppleDouble = (path: string) =>
	(path.split("/").at(-1) ?? "").startsWith("._");

/** A file that runs on its own: a script (`#!`) or an ELF binary. */
export const execHeader = (head: Uint8Array) =>
	(head[0] === 0x23 && head[1] === 0x21) ||
	(head[0] === 0x7f &&
		head[1] === 0x45 &&
		head[2] === 0x4c &&
		head[3] === 0x46);

/**
 * argv: the image's modes before the restore (`<octal> <path>` lines), the
 * staged file or directory, its path in the container. Prints a chmod for
 * each restored file whose image mode adds bits to the saved one.
 */
const MODES_SCRIPT = `import os,shlex,sys
before,staged,dest=sys.argv[1:4]
image={}
try:
 for line in open(before,errors='replace'):
  mode,_,path=line.rstrip('\\n').partition(' ')
  try:image[path]=int(mode,8)
  except ValueError:pass
except OSError:pass
def emit(path,target):
 if os.path.islink(path) or not os.path.isfile(path):return
 mine=os.lstat(path).st_mode&0o7777;want=mine|image.get(target,0)
 if want!=mine:print('chmod %o %s'%(want,shlex.quote(target)))
if os.path.isdir(staged):
 for top,dirs,files in os.walk(staged):
  for name in files:
   path=os.path.join(top,name);emit(path,dest.rstrip('/')+'/'+os.path.relpath(path,staged))
else:emit(staged,dest)`;

/**
 * Tasks whose service sidecar reads its state back from the restored
 * artifact files, checked in the sidecar image (why, per task). Every other
 * task with sidecars cannot be restored faithfully: its samples are unfit.
 */
export const SIDECAR_STATE_RELOADED: Readonly<Record<string, string>> = {
	"heat-pump-warranty":
		"warranty-portal reads /audit/decisions.json on every request (server.py load_decisions)",
};

/** Why a task's sidecar state cannot be restored for a checker (null when it can, or there are none). */
export function sidecarStateProblem(task: TaskEnvironment): string | null {
	if (!task.sidecars.length || Object.hasOwn(SIDECAR_STATE_RELOADED, task.id))
		return null;
	return task.artifacts.some((artifact) => artifact.service !== "main")
		? "service sidecar state not restorable: its saved files are copied back, but the service keeps its state elsewhere and does not reload them"
		: "service sidecar state not restorable: the saved artifacts hold none of it, so the services start fresh";
}

/** An artifact that is a diff of the working directory (applied, not copied). */
export function isPatchArtifact(task: TaskEnvironment, artifact: Artifact) {
	const source = artifact.source.replace(/\/+$/, "");
	return (
		artifact.service === "main" &&
		source.endsWith(".patch") &&
		task.collect.some(
			(step) =>
				step.service === "main" &&
				step.command.includes(source) &&
				/\bgit\s+diff\b/.test(step.command),
		)
	);
}

/**
 * Where a diff artifact applies: the directory its collect step `cd`s into
 * before `git diff` (the diff's paths are relative to it), else the working
 * directory (null).
 */
export function patchDirectory(task: TaskEnvironment, artifact: Artifact) {
	const source = artifact.source.replace(/\/+$/, "");
	const step = task.collect.find(
		(entry) =>
			entry.command.includes(source) && /\bgit\s+diff\b/.test(entry.command),
	);
	const before = step?.command.slice(0, step.command.search(/\bgit\s+diff\b/));
	const dirs = [...(before ?? "").matchAll(/\bcd\s+([^\s;&|]+)/g)].map(
		(match) => match[1],
	);
	const dir = dirs.at(-1);
	return dir?.startsWith("/") ? dir : null;
}

export const artifactBase = (artifact: Artifact) =>
	(artifact.source.replace(/\/+$/, "") || "/").split("/").at(-1) as string;

/**
 * Files the run delivered in the task container outside the working
 * directory (sidecar artifacts and applied diffs are not files the checker
 * reads directly).
 */
export function outsideFiles(task: TaskEnvironment, workdir: string) {
	const root = workdir.replace(/\/+$/, "");
	return task.artifacts
		.filter(
			(artifact) =>
				artifact.service === "main" && !isPatchArtifact(task, artifact),
		)
		.map((artifact) => artifact.source.replace(/\/+$/, "") || "/")
		.filter((source) => source !== root && !source.startsWith(`${root}/`));
}

/**
 * Restore script, run as root on the agent VM after the environment's setup
 * (root /tb), or on a local Docker host for the dry run (its own root). The
 * root holds runtime.sh (WD, MOUNTS, and optionally MAIN and PROJECT: the main
 * container's name and the compose project, default tb), compose.json and
 * override.yaml, workspace.tgz (artifact `<index>/<basename>`, the hard-set
 * staging layout) and forbidden.sha256 (hashes of the task's tests/ and
 * solution/ files). Prints the markers parseRestoreLog reads.
 */
export function restoreScript(task: TaskEnvironment, root = "/tb") {
	const r = q(root);
	const lines = [
		"#!/bin/bash",
		"set -uo pipefail",
		`ROOT=${r}`,
		'source "$ROOT/runtime.sh"',
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
		"MAIN=${MAIN:-tb}; PROJECT=${PROJECT:-tb}; MOUNTS=${MOUNTS:-}",
		// AppleDouble entries (`._*`, macOS tar metadata) are never artifacts.
		`rm -rf "$ROOT/workspace" && mkdir -p "$ROOT/workspace" && tar --no-same-owner --exclude=${q(APPLEDOUBLE)} -xzf "$ROOT/workspace.tgz" -C "$ROOT/workspace"`,
		`echo "APPLEDOUBLE $(find "$ROOT/workspace" -name ${q(APPLEDOUBLE)} | wc -l | tr -d ' ')"`,
		'cid() { if [ "$1" = main ]; then echo "$MAIN"; else docker compose -p "$PROJECT" -f "$ROOT/compose.json" -f "$ROOT/override.yaml" ps -q "$1"; fi; }',
		"restarted=''",
		// Same files in both places: sha256 of every staged file checked in the
		// restored copy; a replaced directory (exact=1) also holds no file the
		// artifact did not have ("extra"). Labelled RECHECK after a restart.
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
		'verify() { local i=$1 svc=$2 path=$3 staged=$4 label=${5:-RESTORED} exact=${6:-0} t; t=$(mktemp -d); docker cp "$(cid "$svc")":"$path" - 2>/dev/null | tar -x -C "$t" 2>/dev/null; local got="$t/$(basename "$path")"; if [ -d "$staged" ]; then (cd "$staged" && find . -type f -print0 | sort -z | xargs -0 -r sha256sum) > "$t.sums"; n=$(wc -l < "$t.sums" | tr -d " "); if [ -d "$got" ] && (cd "$got" && sha256sum -c --quiet "$t.sums" >/dev/null 2>&1); then if [ "$exact" = 1 ] && [ "$(cd "$got" && find . -type f ! -path "./.git/*" | wc -l | tr -d " ")" != "$n" ]; then echo "$label $i extra $n"; else echo "$label $i ok $n"; fi; else echo "$label $i mismatch $n"; fi; else if [ -f "$got" ] && cmp -s "$staged" "$got"; then echo "$label $i ok 1"; else echo "$label $i mismatch 1"; fi; fi; rm -rf "$t" "$t.sums"; }',
		// File modes: a file the image already had keeps its own mode bits as
		// well as the saved ones (some backends save every file as 0644).
		`modes() { docker exec -u 0 "$(cid "$1")" sh -c 'find "$1" -type f -exec stat -c "%a %n" {} + 2>/dev/null' sh "$2" > "$3" 2>/dev/null || true; }`,
		`fixmodes() { local i=$1 svc=$2 path=$3 staged=$4 before=$5 out; if ! command -v python3 >/dev/null 2>&1; then echo "MODES $i skipped"; return; fi; out=$(python3 -I -c ${q(MODES_SCRIPT)} "$before" "$staged" "$path"); if [ -n "$out" ]; then printf '%s\\n' "$out" | docker exec -i -u 0 "$(cid "$svc")" sh; fi; echo "MODES $i $(printf '%s' "$out" | grep -c chmod)"; }`,
		"BEFORE=$(mktemp -d)",
	];
	task.artifacts.forEach((artifact, index) => {
		const source = artifact.source.replace(/\/+$/, "") || "/";
		const base = artifactBase(artifact);
		const parent = source.slice(0, source.lastIndexOf("/")) || "/";
		const staged = `${root}/workspace/${index}/${base}`;
		const service = q(artifact.service);
		const container = `"$(cid ${service})"`;
		const before = `"$BEFORE/${index}"`;
		const exact = artifact.exclude.length ? 0 : 1;
		lines.push(
			`if [ ! -e ${q(staged)} ]; then echo ${q(`RESTORED ${index} missing 0`)};`,
			// A directory is replaced (its files deleted first, the git history
			// kept), unless the grader saw it with excludes: then it is overlaid
			// so the excluded files stay as the image has them.
			`elif [ -d ${q(staged)} ]; then rm -rf ${q(`${staged}/.git`)}; modes ${service} ${q(source)} ${before}; docker exec -u 0 ${container} sh -c ${q(
				artifact.exclude.length
					? `mkdir -p ${q(source)}`
					: `mkdir -p ${q(source)} && find ${q(source)} -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +`,
			)} && docker cp ${q(staged)}/. ${container}:${q(source)} && fixmodes ${index} ${service} ${q(source)} ${q(staged)} ${before} && verify ${index} ${service} ${q(source)} ${q(staged)} RESTORED ${exact} || echo ${q(`RESTORED ${index} failed 0`)};`,
			`else modes ${service} ${q(source)} ${before}; docker exec -u 0 ${container} mkdir -p ${q(parent)} && docker cp ${q(staged)} ${container}:${q(source)} && fixmodes ${index} ${service} ${q(source)} ${q(staged)} ${before} && verify ${index} ${service} ${q(source)} ${q(staged)} || echo ${q(`RESTORED ${index} failed 0`)}; fi`,
		);
		if (artifact.service !== "main")
			lines.push(
				`case " $restarted " in *" ${artifact.service} "*) ;; *) restarted="$restarted ${artifact.service}" ;; esac`,
			);
		const patchDir = patchDirectory(task, artifact);
		const applyIn = patchDir ? q(patchDir) : '"$WD"';
		if (isPatchArtifact(task, artifact))
			lines.push(
				// Applied as the verifier does (on the image's working directory),
				// checked by reversing it, then removed: the agent never had it.
				`if docker exec -u 0 -w ${applyIn} "$MAIN" git apply --binary --whitespace=nowarn ${q(source)} && docker exec -u 0 -w ${applyIn} "$MAIN" git apply --check -R --binary ${q(source)}; then echo "PATCH ${index} applied"; else echo "PATCH ${index} failed"; fi`,
				`docker exec -u 0 "$MAIN" rm -f ${q(source)}`,
				// A diff applied outside the working directory's own repository
				// lists its files by absolute path.
				...(patchDir
					? [
							`[ ${q(patchDir)} = "$WD" ] || docker exec -u 0 "$MAIN" git -c safe.directory="*" -C ${q(patchDir)} status --porcelain=v1 --untracked-files=all 2>/dev/null | cut -c4- | sed ${q(`s|^|CHANGED ${patchDir.replace(/\/+$/, "")}/|`)} | head -300`,
						]
					: []),
			);
	});
	lines.push(
		// A sidecar re-reads its files only when it starts.
		'for svc in $restarted; do c=$(cid "$svc"); docker restart "$c" >/dev/null; for _ in $(seq 60); do s=$(docker inspect -f \'{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}\' "$c"); [ "$s" = healthy ] || [ "$s" = running ] && break; sleep 2; done; echo "SIDECAR $svc $s"; done',
		// A sidecar that rewrites its files when it starts lost the restored state.
		...task.artifacts.flatMap((artifact, index) =>
			artifact.service === "main" || isPatchArtifact(task, artifact)
				? []
				: [
						`[ -e ${q(`${root}/workspace/${index}/${artifactBase(artifact)}`)} ] && verify ${index} ${q(artifact.service)} ${q(artifact.source.replace(/\/+$/, "") || "/")} ${q(`${root}/workspace/${index}/${artifactBase(artifact)}`)} RECHECK`,
					],
		),
		// Both sides keep access, as in setup (VM bind mounts only); files
		// nobody may read (execute-only tools) keep their mode, without ACLs.
		`if [ -n "$MOUNTS" ]; then chown -R 1000:1000 $MOUNTS; setfacl -R -m u:1000:rwX,d:u:1000:rwX,m:rwX,d:m:rwX $MOUNTS; cuid=$(docker exec "$MAIN" id -u); if [ "$cuid" != 0 ] && [ "$cuid" != 1000 ]; then setfacl -R -m u:$cuid:rwX,d:u:$cuid:rwX $MOUNTS; fi; ${UNREADABLE_KEEP_MODE}; fi`,
		// The grader's files never reach the checker.
		"docker exec \"$MAIN\" sh -c 'test -e /tests' && echo 'PRESENT /tests' || echo 'ABSENT /tests'",
		"docker exec \"$MAIN\" sh -c 'test -e /solution' && echo 'PRESENT /solution' || echo 'ABSENT /solution'",
		// No file in the working directory is identical to a test or solution file.
		'if [ -s "$ROOT/forbidden.sha256" ]; then docker exec -w "$WD" "$MAIN" sh -c \'find . -xdev -type f -size -20M ! -path "./.git/*" -exec sha256sum {} + 2>/dev/null\' | grep -F -f "$ROOT/forbidden.sha256" | sed \'s/^[0-9a-f]* */FORBIDDEN /\' | head -20; fi',
		'rm -rf "$ROOT/workspace" "$BEFORE"',
		'docker exec -u 0 "$MAIN" git -c safe.directory="*" -C "$WD" status --porcelain=v1 --untracked-files=all 2>/dev/null | cut -c4- | sed \'s/^/CHANGED /\' | head -300',
		'echo "RESTORE_DONE"',
	);
	return `${lines.join("\n")}\n`;
}

type ArtifactState = "ok" | "mismatch" | "extra" | "missing" | "failed";

export type RestoreResult = {
	readonly artifacts: readonly {
		index: number;
		state: ArtifactState;
		files: number;
	}[];
	/** Sidecar artifacts checked again after their service restarted. */
	readonly rechecks?: readonly {
		index: number;
		state: ArtifactState;
		files: number;
	}[];
	/** Files whose mode the image's mode widened, per artifact. */
	readonly modes?: readonly { index: number; changed: number | null }[];
	/** AppleDouble files left in the extracted workspace (always 0 since the fix). */
	readonly appleDouble?: number | null;
	readonly patches: readonly { index: number; applied: boolean }[];
	readonly sidecars: readonly { service: string; state: string }[];
	readonly testsAbsent: boolean;
	readonly solutionAbsent: boolean;
	/** Files in the environment identical to a task test or solution file. */
	readonly forbidden: readonly string[];
	readonly changedFiles: readonly string[];
	readonly done: boolean;
};

export function parseRestoreLog(log: string): RestoreResult {
	const lines = log.split("\n");
	const pick = (pattern: RegExp) =>
		lines.flatMap((line) => {
			const match = pattern.exec(line);
			return match ? [match] : [];
		});
	const states = (label: string) =>
		pick(
			new RegExp(
				`^${label} (\\d+) (ok|mismatch|extra|missing|failed)\\s+(\\d+)$`,
			),
		).map((match) => ({
			index: Number(match[1]),
			state: match[2] as ArtifactState,
			files: Number(match[3]),
		}));
	const appleDouble = pick(/^APPLEDOUBLE (\d+)$/)[0];
	return {
		artifacts: states("RESTORED"),
		rechecks: states("RECHECK"),
		modes: pick(/^MODES (\d+) (\d+|skipped)$/).map((match) => ({
			index: Number(match[1]),
			changed: match[2] === "skipped" ? null : Number(match[2]),
		})),
		appleDouble: appleDouble ? Number(appleDouble[1]) : null,
		patches: pick(/^PATCH (\d+) (applied|failed)$/).map((match) => ({
			index: Number(match[1]),
			applied: match[2] === "applied",
		})),
		sidecars: pick(/^SIDECAR (\S+) (\S*)$/).map((match) => ({
			service: match[1],
			state: match[2],
		})),
		testsAbsent: lines.includes("ABSENT /tests"),
		solutionAbsent: lines.includes("ABSENT /solution"),
		forbidden: pick(/^FORBIDDEN (.+)$/).map((match) => match[1]),
		changedFiles: pick(/^CHANGED (.+)$/).map((match) => match[1]),
		done: lines.includes("RESTORE_DONE"),
	};
}

/** Problems that make a restored environment unfit for a checker run (empty when fit). */
export function restoreProblems(task: TaskEnvironment, result: RestoreResult) {
	const problems: string[] = [];
	if (!result.done) problems.push("restore did not finish");
	if (result.appleDouble)
		problems.push(`${result.appleDouble} AppleDouble file(s) in the workspace`);
	task.artifacts.forEach((artifact, index) => {
		const entry = result.artifacts.find((item) => item.index === index);
		if (entry?.state !== "ok")
			problems.push(
				`artifact ${artifact.source} ${entry?.state === "extra" ? "holds files the artifact did not have" : (entry?.state ?? "not restored")}`,
			);
		const recheck = result.rechecks?.find((item) => item.index === index);
		if (recheck && recheck.state !== "ok")
			problems.push(
				`sidecar ${artifact.service} changed ${artifact.source} when it restarted (state not kept)`,
			);
		if (
			isPatchArtifact(task, artifact) &&
			!result.patches.some((patch) => patch.index === index && patch.applied)
		)
			problems.push(`diff ${artifact.source} did not apply`);
	});
	for (const sidecar of result.sidecars)
		if (!["healthy", "running"].includes(sidecar.state))
			problems.push(`sidecar ${sidecar.service} is ${sidecar.state}`);
	if (!result.testsAbsent) problems.push("/tests is present");
	if (!result.solutionAbsent) problems.push("/solution is present");
	return problems;
}
