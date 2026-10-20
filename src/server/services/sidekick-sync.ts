import { randomUUID } from "node:crypto";
import type { WorkspaceId } from "#/domain/ids";
import { posixShellQuoted as quote } from "#/domain/posix-command";
import {
	SIDEKICK_SYNC_STATUSES,
	type SidekickSyncStatus,
	sidekickRoundRef,
} from "#/domain/sidekick";
import { PROJECT_CWD_PATH } from "../adapters/freestyle/clone-project";
import type { WorkspaceMachines } from "./workspace-machines";

/**
 * Syncs a sidekick's fork with its lead's checkout before a new round
 * (src/domain/sidekick.ts). The lead's checkout is the source of truth:
 *
 * 1. In the lead's VM its working tree (uncommitted and untracked files
 *    included, through a temporary index so its own index is untouched) is
 *    committed as L on top of its HEAD, kept under a ref, and bundled
 *    without what the fork already has (the lead commit it was forked from
 *    and the last L it received).
 * 2. In the fork the sidekick's leftovers are committed, its head is kept at
 *    refs/ytimesy/sidekick/round-<n>, the bundle is fetched, and the
 *    checkout is reset to L. Its work since its last base that the lead has
 *    not applied is replayed on top with a cherry-pick of one squashed
 *    commit (a three-way merge whose base is the old base, so work the lead
 *    already applied drops out); on a conflict the fork stays at L.
 * 3. L becomes the fork's new base: the next report's patch is
 *    `git diff L HEAD`, which applies to the lead's checkout as it was at
 *    the round's start, and its bundle is cut at the lead's HEAD.
 *
 * Ignored files (dependencies, build output) are not synced; the fork keeps
 * its own.
 */

const GIT =
	"git -c user.name=ytimesy-agent -c user.email=agent@ytimesy.invalid";
/** A lead checkout bundle larger than this is not copied: the sync fails. */
const MAX_BUNDLE_BASE64 = 24_000_000;

export const sidekickLeadRefs = (label: string) => ({
	checkout: `refs/ytimesy/sidekick/${label}/checkout`,
	synced: `refs/ytimesy/sidekick/${label}/synced`,
});

/** Run in the lead's VM: snapshot its working tree as a commit and bundle it. */
export function leadSnapshotScript(input: {
	readonly cwd: string;
	readonly label: string;
	readonly round: number;
	/** A lead commit the fork has (the one it was forked from). */
	readonly forkKnows: string;
	readonly out: string;
}) {
	const refs = sidekickLeadRefs(input.label);
	const out = quote(input.out);
	return [
		"set -e",
		`cd ${quote(input.cwd)}`,
		"head=$(git rev-parse HEAD)",
		'index=$(mktemp) && rm -f "$index"',
		'cp "$(git rev-parse --git-path index)" "$index" 2>/dev/null || true',
		'GIT_INDEX_FILE="$index" git add -A',
		'tree=$(GIT_INDEX_FILE="$index" git write-tree)',
		'rm -f "$index"',
		`lead=$(${GIT} commit-tree "$tree" -p "$head" -m ${quote(`ytimesy lead checkout (sidekick ${input.label} round ${input.round})`)})`,
		`git update-ref ${refs.checkout} "$lead"`,
		'exclude=""',
		`for known in ${quote(input.forkKnows)} "$(git rev-parse -q --verify ${refs.synced} || true)"; do`,
		'  if [ -n "$known" ] && git cat-file -e "$known^{commit}" 2>/dev/null; then exclude="$exclude ^$known"; fi',
		"done",
		`rm -f ${out}.bundle`,
		`git bundle create -q ${out}.bundle ${refs.checkout} $exclude`,
		`base64 < ${out}.bundle | tr -d '\\n' > ${out}`,
		`rm -f ${out}.bundle`,
		'echo "$head $lead"',
	].join("\n");
}

/** Run in the fork: keep its head, take the lead's checkout, replay unapplied work. */
export function forkSyncScript(input: {
	readonly cwd: string;
	readonly label: string;
	/** The round that ends (its head is kept under a ref). */
	readonly endedRound: number;
	/** The fork's current base: its work is base..HEAD. */
	readonly base: string;
	readonly payload: string;
}) {
	const refs = sidekickLeadRefs(input.label);
	const fetched = "refs/ytimesy/lead/checkout";
	return [
		"set -e",
		`cd ${quote(input.cwd)}`,
		"git add -A",
		`if ! git diff --cached --quiet; then ${GIT} commit -q --no-verify -m ${quote(`wip (sidekick ${input.label} round ${input.endedRound})`)}; fi`,
		"own=$(git rev-parse HEAD)",
		`git update-ref ${sidekickRoundRef(input.endedRound)} "$own"`,
		'bundle=$(mktemp) && rm -f "$bundle"',
		`base64 -d < ${quote(input.payload)} > "$bundle.bundle"`,
		`rm -f ${quote(input.payload)}`,
		`git fetch -q "$bundle.bundle" +${refs.checkout}:${fetched}`,
		'rm -f "$bundle.bundle"',
		`lead=$(git rev-parse ${fetched})`,
		"status=unchanged",
		'carry=""',
		`if [ "$(git rev-parse "$own^{tree}")" != "$(git rev-parse ${quote(`${input.base}^{tree}`)})" ]; then`,
		`  carry=$(${GIT} commit-tree "$own^{tree}" -p ${quote(input.base)} -m "sidekick work since its last base")`,
		"fi",
		"branch=$(git symbolic-ref -q --short HEAD || echo ytimesy-sidekick)",
		'git checkout -q -f -B "$branch" "$lead"',
		"git clean -fdq",
		'if [ -n "$carry" ]; then',
		`  if ${GIT} cherry-pick --no-commit "$carry" >/dev/null 2>&1; then`,
		"    if git diff --cached --quiet; then status=clean; else",
		`      ${GIT} commit -q --no-verify -m "sidekick work the lead has not applied (carried over)"`,
		"      status=carried",
		"    fi",
		"  else",
		"    git cherry-pick --quit >/dev/null 2>&1 || true",
		'    git reset -q --hard "$lead"',
		"    git clean -fdq",
		"    status=conflict",
		"  fi",
		"fi",
		'echo "$status $lead $own"',
	].join("\n");
}

function parseHashes(stdout: string, count: number) {
	const parts = stdout.trim().split(/\s+/).slice(-count);
	return parts.length === count ? parts : null;
}

const isHash = (value: string | undefined) =>
	/^[0-9a-f]{40,64}$/.test(value ?? "");

export type SidekickSync = {
	readonly status: SidekickSyncStatus;
	/** The lead's checkout as a commit: the fork's new base. */
	readonly base: string;
	/** The lead's HEAD at the sync: the next bundle's boundary. */
	readonly parentHead: string;
	/** The sidekick's head at the end of the last round. */
	readonly previousHead: string;
};

/** Syncs the fork with the lead's checkout (see the module comment). */
export async function syncSidekickFork(input: {
	readonly machines: WorkspaceMachines;
	readonly leadVm: WorkspaceId;
	readonly forkVm: WorkspaceId;
	readonly label: string;
	/** The round about to start. */
	readonly round: number;
	readonly base: string;
	readonly parentHead: string;
}): Promise<SidekickSync> {
	const { machines, leadVm, forkVm } = input;
	const [leadCwd, forkCwd] = await Promise.all(
		[leadVm, forkVm].map(async (vm) =>
			(await machines.readTextFile(vm, PROJECT_CWD_PATH))?.trim(),
		),
	);
	if (!leadCwd?.startsWith("/") || !forkCwd?.startsWith("/"))
		throw new Error("A repository path is unavailable.");
	const out = `/tmp/ytimesy-sidekick-${randomUUID()}.b64`;
	const snapshot = await machines.exec(
		leadVm,
		leadSnapshotScript({
			cwd: leadCwd,
			label: input.label,
			round: input.round,
			forkKnows: input.parentHead,
			out,
		}),
		120_000,
	);
	const [leadHead, lead] = parseHashes(snapshot.stdout, 2) ?? [];
	if (snapshot.exitCode !== 0 || !isHash(leadHead) || !isHash(lead))
		throw new Error(
			`Your checkout could not be snapshotted: ${snapshot.stderr.slice(-400)}`,
		);
	const bundle = await machines.readTextFile(leadVm, out);
	await machines.exec(leadVm, `rm -f ${quote(out)}`, 15_000).catch(() => {});
	if (!bundle) throw new Error("Your checkout's bundle could not be read.");
	if (bundle.length > MAX_BUNDLE_BASE64)
		throw new Error(
			"Your checkout's changes since the fork are too large to sync (over 18 MB); do this round yourself or start a fresh writer.",
		);
	const payload = `/tmp/ytimesy-sidekick-${randomUUID()}.b64`;
	await machines.writeTextFile(forkVm, payload, bundle);
	const synced = await machines.exec(
		forkVm,
		forkSyncScript({
			cwd: forkCwd,
			label: input.label,
			endedRound: input.round - 1,
			base: input.base,
			payload,
		}),
		180_000,
	);
	const [status, base, previousHead] = parseHashes(synced.stdout, 3) ?? [];
	if (
		synced.exitCode !== 0 ||
		!(SIDEKICK_SYNC_STATUSES as readonly string[]).includes(status ?? "") ||
		!isHash(base) ||
		!isHash(previousHead)
	)
		throw new Error(
			`The sidekick's fork could not be synced: ${synced.stderr.slice(-400)}`,
		);
	const refs = sidekickLeadRefs(input.label);
	const marked = await machines.exec(
		leadVm,
		`git -C ${quote(leadCwd)} update-ref ${refs.synced} ${quote(lead as string)}`,
		30_000,
	);
	if (marked.exitCode !== 0)
		throw new Error(
			`The sync could not be recorded in your checkout: ${marked.stderr.slice(-200)}`,
		);
	return {
		status: status as SidekickSyncStatus,
		base: base as string,
		parentHead: leadHead as string,
		previousHead: previousHead as string,
	};
}
