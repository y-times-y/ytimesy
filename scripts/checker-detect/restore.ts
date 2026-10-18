// Restores a finished run's saved workspace into a fresh task environment for
// the checker detection test (docs/checker-detect.md). The environment comes
// from scripts/hard-set/environment.ts (task images, working directory copied
// out of the image, command route into the container); this adds the saved
// artifacts on top, exactly as Harbor's separate verifier received them, so
// the checker sees what the grader graded: each artifact at its own path in
// its own service, and a diff artifact (`/tmp/agent.patch` made by a
// `git diff` collect step) applied to the working directory.
import type { Artifact, TaskEnvironment } from "../hard-set/environment";

const q = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

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
		'rm -rf "$ROOT/workspace" && mkdir -p "$ROOT/workspace" && tar --no-same-owner -xzf "$ROOT/workspace.tgz" -C "$ROOT/workspace"',
		'cid() { if [ "$1" = main ]; then echo "$MAIN"; else docker compose -p "$PROJECT" -f "$ROOT/compose.json" -f "$ROOT/override.yaml" ps -q "$1"; fi; }',
		"restarted=''",
		// Same files in both places: sha256 of every staged file checked in the restored copy.
		'verify() { local i=$1 svc=$2 path=$3 staged=$4 t; t=$(mktemp -d); docker cp "$(cid "$svc")":"$path" - 2>/dev/null | tar -x -C "$t" 2>/dev/null; local got="$t/$(basename "$path")"; if [ -d "$staged" ]; then (cd "$staged" && find . -type f -print0 | sort -z | xargs -0 -r sha256sum) > "$t.sums"; n=$(wc -l < "$t.sums" | tr -d " "); if [ -d "$got" ] && (cd "$got" && sha256sum -c --quiet "$t.sums" >/dev/null 2>&1); then echo "RESTORED $i ok $n"; else echo "RESTORED $i mismatch $n"; fi; else if [ -f "$got" ] && cmp -s "$staged" "$got"; then echo "RESTORED $i ok 1"; else echo "RESTORED $i mismatch 1"; fi; fi; rm -rf "$t" "$t.sums"; }',
	];
	task.artifacts.forEach((artifact, index) => {
		const source = artifact.source.replace(/\/+$/, "") || "/";
		const base = artifactBase(artifact);
		const parent = source.slice(0, source.lastIndexOf("/")) || "/";
		const staged = `${root}/workspace/${index}/${base}`;
		const service = q(artifact.service);
		const container = `"$(cid ${service})"`;
		lines.push(
			`if [ ! -e ${q(staged)} ]; then echo ${q(`RESTORED ${index} missing 0`)};`,
			// A directory is replaced (its files deleted first, the git history
			// kept), unless the grader saw it with excludes: then it is overlaid
			// so the excluded files stay as the image has them.
			`elif [ -d ${q(staged)} ]; then rm -rf ${q(`${staged}/.git`)}; docker exec -u 0 ${container} sh -c ${q(
				artifact.exclude.length
					? `mkdir -p ${q(source)}`
					: `mkdir -p ${q(source)} && find ${q(source)} -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +`,
			)} && docker cp ${q(staged)}/. ${container}:${q(source)} && verify ${index} ${service} ${q(source)} ${q(staged)} || echo ${q(`RESTORED ${index} failed 0`)};`,
			`else docker exec -u 0 ${container} mkdir -p ${q(parent)} && docker cp ${q(staged)} ${container}:${q(source)} && verify ${index} ${service} ${q(source)} ${q(staged)} || echo ${q(`RESTORED ${index} failed 0`)}; fi`,
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
		// Both sides keep access, as in setup (VM bind mounts only).
		'if [ -n "$MOUNTS" ]; then chown -R 1000:1000 $MOUNTS; setfacl -R -m u:1000:rwX,d:u:1000:rwX,m:rwX,d:m:rwX $MOUNTS; cuid=$(docker exec "$MAIN" id -u); if [ "$cuid" != 0 ] && [ "$cuid" != 1000 ]; then setfacl -R -m u:$cuid:rwX,d:u:$cuid:rwX $MOUNTS; fi; fi',
		// The grader's files never reach the checker.
		"docker exec \"$MAIN\" sh -c 'test -e /tests' && echo 'PRESENT /tests' || echo 'ABSENT /tests'",
		"docker exec \"$MAIN\" sh -c 'test -e /solution' && echo 'PRESENT /solution' || echo 'ABSENT /solution'",
		// No file in the working directory is identical to a test or solution file.
		'if [ -s "$ROOT/forbidden.sha256" ]; then docker exec -w "$WD" "$MAIN" sh -c \'find . -xdev -type f -size -20M ! -path "./.git/*" -exec sha256sum {} + 2>/dev/null\' | grep -F -f "$ROOT/forbidden.sha256" | sed \'s/^[0-9a-f]* */FORBIDDEN /\' | head -20; fi',
		'rm -rf "$ROOT/workspace"',
		'docker exec -u 0 "$MAIN" git -c safe.directory="*" -C "$WD" status --porcelain=v1 --untracked-files=all 2>/dev/null | cut -c4- | sed \'s/^/CHANGED /\' | head -300',
		'echo "RESTORE_DONE"',
	);
	return `${lines.join("\n")}\n`;
}

export type RestoreResult = {
	readonly artifacts: readonly {
		index: number;
		state: "ok" | "mismatch" | "missing" | "failed";
		files: number;
	}[];
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
	return {
		artifacts: pick(
			/^RESTORED (\d+) (ok|mismatch|missing|failed)\s+(\d+)$/,
		).map((match) => ({
			index: Number(match[1]),
			state: match[2] as "ok" | "mismatch" | "missing" | "failed",
			files: Number(match[3]),
		})),
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
	task.artifacts.forEach((artifact, index) => {
		const entry = result.artifacts.find((item) => item.index === index);
		if (entry?.state !== "ok")
			problems.push(
				`artifact ${artifact.source} ${entry?.state ?? "not restored"}`,
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
