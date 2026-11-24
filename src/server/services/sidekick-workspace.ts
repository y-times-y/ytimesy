import type { WorkspaceId } from "#/domain/ids";
import { posixShellQuoted as quote } from "#/domain/posix-command";
import { sidekickRoundRef } from "#/domain/sidekick";
import { PROJECT_CWD_PATH } from "../adapters/freestyle/clone-project";
import {
	MANAGED_GIT,
	MANAGED_GIT_TRAILER,
} from "../adapters/managed-git-identity";
import type { WorkspaceMachines } from "./workspace-machines";

/**
 * Lead mode fusion's shared workspace (src/domain/sidekick.ts): the
 * sidekick works in the lead's own checkout, so a round needs no fork,
 * sync or patch. The runtime only snapshots the checkout's working tree
 * (uncommitted and untracked files included, through a temporary index so
 * the checkout's own index is untouched) as a commit at a round's start and
 * end, kept under refs/ytimesy/sidekick/<label>/round-<n>-start|end; the
 * lead reviews a round with `git diff <start> <end>`. Neither the working
 * tree, the index nor HEAD changes: the sidekick's work stays the lead's
 * uncommitted work, and the turn's usual commit publishes it.
 */

/** Commits the working tree as it is (on top of HEAD) and points `ref` at it. */
export function checkoutSnapshotScript(input: {
	readonly cwd: string;
	readonly ref: string;
	readonly message: string;
}) {
	return [
		"set -e",
		`cd ${quote(input.cwd)}`,
		"head=$(git rev-parse -q --verify HEAD || true)",
		'index=$(mktemp) && rm -f "$index"',
		'cp "$(git rev-parse --git-path index)" "$index" 2>/dev/null || true',
		'GIT_INDEX_FILE="$index" git add -A',
		'tree=$(GIT_INDEX_FILE="$index" git write-tree)',
		'rm -f "$index"',
		`commit=$(${MANAGED_GIT} commit-tree "$tree" \${head:+-p "$head"} -m ${quote(input.message)} -m ${quote(MANAGED_GIT_TRAILER)})`,
		`git update-ref ${quote(input.ref)} "$commit"`,
		'echo "SNAPSHOT $commit"',
	].join("\n");
}

const isHash = (value: string | undefined) =>
	/^[0-9a-f]{40,64}$/.test(value ?? "");

async function checkoutCwd(machines: WorkspaceMachines, vm: WorkspaceId) {
	const cwd = (await machines.readTextFile(vm, PROJECT_CWD_PATH))?.trim();
	if (!cwd?.startsWith("/"))
		throw new Error("A repository path is unavailable.");
	return cwd;
}

async function snapshot(
	machines: WorkspaceMachines,
	vm: WorkspaceId,
	cwd: string,
	ref: string,
	message: string,
) {
	const result = await machines.exec(
		vm,
		checkoutSnapshotScript({ cwd, ref, message }),
		120_000,
	);
	const commit = /SNAPSHOT ([0-9a-f]+)/.exec(result.stdout)?.[1];
	if (result.exitCode !== 0 || !isHash(commit))
		throw new Error(
			`The checkout could not be snapshotted: ${result.stderr.slice(-400)}`,
		);
	return commit as string;
}

/** Snapshots the lead's checkout at a round's start; returns the commit. */
export async function markSidekickRoundStart(input: {
	readonly machines: WorkspaceMachines;
	readonly vm: WorkspaceId;
	readonly label: string;
	readonly round: number;
}) {
	const cwd = await checkoutCwd(input.machines, input.vm);
	return snapshot(
		input.machines,
		input.vm,
		cwd,
		sidekickRoundRef(input.label, input.round, "start"),
		`ytimesy checkout before sidekick ${input.label} round ${input.round}`,
	);
}

export type SidekickRoundChanges = {
	/** The checkout at the round's end, as a commit. */
	readonly end: string;
	/** Paths the round changed (added, modified, deleted). */
	readonly files: readonly string[];
	/** `git diff --stat <start> <end>`. */
	readonly stat: string;
};

/** Snapshots the checkout at a round's end and lists what changed since `base`. */
export async function sidekickRoundChanges(input: {
	readonly machines: WorkspaceMachines;
	readonly vm: WorkspaceId;
	readonly label: string;
	readonly round: number;
	readonly base: string;
}): Promise<SidekickRoundChanges> {
	if (!isHash(input.base)) throw new Error("The round's start is unknown.");
	const cwd = await checkoutCwd(input.machines, input.vm);
	const end = await snapshot(
		input.machines,
		input.vm,
		cwd,
		sidekickRoundRef(input.label, input.round, "end"),
		`ytimesy checkout after sidekick ${input.label} round ${input.round}`,
	);
	const diff = await input.machines.exec(
		input.vm,
		[
			`cd ${quote(cwd)}`,
			`git diff --no-renames --name-only ${input.base} ${end}`,
			"echo ---STAT---",
			`git diff --no-renames --stat=120 ${input.base} ${end} | tail -n 40`,
		].join(" && "),
		60_000,
	);
	if (diff.exitCode !== 0)
		throw new Error(
			`The round's changes could not be listed: ${diff.stderr.slice(-400)}`,
		);
	const [names = "", stat = ""] = diff.stdout.split("---STAT---\n");
	return {
		end,
		files: names.split("\n").filter(Boolean),
		stat: stat.trimEnd(),
	};
}
