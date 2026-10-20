import { randomUUID } from "node:crypto";
import type { WorkspaceId } from "#/domain/ids";
import { posixShellQuoted as quote } from "#/domain/posix-command";
import {
	type WriterPatch,
	writerPatchPath,
	writerPatchRef,
} from "#/domain/subagent";
import { PROJECT_CWD_PATH } from "../adapters/freestyle/clone-project";
import type { WorkspaceMachines } from "./workspace-machines";

/**
 * A writer subagent's git round trip (docs/subagents.md, "Writers"): the
 * fork commits the inherited working tree as its fork-base, the child works
 * and commits as it likes, and at the end the runtime bundles
 * <parent HEAD>..HEAD (work in progress auto-committed) and writes the patch
 * and the ref into the parent's checkout. The parent reviews with git diff
 * and applies with `git apply -3` or a merge; nothing merges automatically.
 */

const GIT =
	"git -c user.name=ytimesy-agent -c user.email=agent@ytimesy.invalid";
/** A bundle larger than this is not copied; the patch still is. */
const MAX_BUNDLE_BASE64 = 24_000_000;

/** Run in the fresh fork: commit what the parent had (uncommitted work included). */
export function forkBaseScript(cwd: string) {
	return [
		"set -e",
		`cd ${quote(cwd)}`,
		"parent_head=$(git rev-parse HEAD)",
		"git add -A",
		`${GIT} commit -q --no-verify --allow-empty -m "ytimesy fork base"`,
		'echo "$parent_head $(git rev-parse HEAD)"',
	].join("\n");
}

export function parseForkBase(stdout: string) {
	const [parentHead, base] = stdout.trim().split(/\s+/).slice(-2);
	if (
		!/^[0-9a-f]{40,64}$/.test(parentHead ?? "") ||
		!/^[0-9a-f]{40,64}$/.test(base ?? "")
	)
		throw new Error("The fork's base commit could not be recorded.");
	return { parentHead, base };
}

/** Run in the fork at the end: auto-commit, then write the patch, stats and bundle. */
export function writerExportScript(input: {
	readonly cwd: string;
	readonly label: string;
	readonly base: string;
	readonly parentHead: string;
	readonly outDir: string;
}) {
	const out = quote(input.outDir);
	return [
		"set -e",
		`cd ${quote(input.cwd)}`,
		"git add -A",
		`if ! git diff --cached --quiet; then ${GIT} commit -q --no-verify -m ${quote(`wip (ytimesy agent ${input.label})`)}; fi`,
		`rm -rf ${out} && mkdir -p ${out}`,
		`git diff --binary ${input.base} HEAD > ${out}/patch`,
		`git diff --numstat ${input.base} HEAD > ${out}/numstat`,
		`{ sha256sum ${out}/patch 2>/dev/null || shasum -a 256 ${out}/patch; } | cut -d' ' -f1 > ${out}/sha256`,
		`if git bundle create -q ${out}/bundle ${input.parentHead}..HEAD 2>/dev/null; then base64 < ${out}/bundle | tr -d '\\n' > ${out}/bundle.b64; else : > ${out}/bundle.b64; fi`,
		`git rev-parse HEAD > ${out}/head`,
	].join("\n");
}

export function parseNumstat(numstat: string) {
	let added = 0;
	let removed = 0;
	const files: string[] = [];
	for (const line of numstat.split("\n")) {
		const [plus, minus, ...path] = line.split("\t");
		if (!path.length) continue;
		files.push(path.join("\t"));
		added += Number(plus) || 0;
		removed += Number(minus) || 0;
	}
	return { files, added, removed };
}

/** Run in the parent: store the patch, fetch the bundle into the agent's ref. */
export function parentImportScript(input: {
	readonly cwd: string;
	readonly label: string;
	readonly patchPayload: string;
	readonly bundlePayload: string | null;
}) {
	const directory = '"$HOME/.ytimesy/agents"';
	const ref = writerPatchRef(input.label);
	return [
		"set -e",
		`mkdir -p ${directory}`,
		`mv ${quote(input.patchPayload)} ${directory}/${quote(`${input.label}.patch`)}`,
		...(input.bundlePayload
			? [
					`bundle=$(mktemp)`,
					`base64 -d < ${quote(input.bundlePayload)} > "$bundle"`,
					`rm -f ${quote(input.bundlePayload)}`,
					`git -C ${quote(input.cwd)} fetch -q "$bundle" +HEAD:${ref}`,
					'rm -f "$bundle"',
				]
			: []),
	].join("\n");
}

/** Forks the parent's VM for a new writer and records its fork-base. */
export async function forkWriterWorkspace(input: {
	readonly machines: WorkspaceMachines;
	readonly parentVm: WorkspaceId;
	readonly slug: string;
}) {
	const fork = input.machines.forkWorkspace;
	if (!fork)
		throw new Error(
			"This workspace provider cannot fork a running VM, so writer agents are unavailable. Do this work yourself.",
		);
	const forked = await fork(input.parentVm, input.slug);
	const cwd = (
		await input.machines.readTextFile(forked.vm, PROJECT_CWD_PATH)
	)?.trim();
	if (!cwd?.startsWith("/"))
		throw new Error("The fork has no prepared repository path.");
	const result = await input.machines.exec(
		forked.vm,
		forkBaseScript(cwd),
		60_000,
	);
	if (result.exitCode !== 0)
		throw new Error(
			`The fork's base commit failed: ${result.stderr.slice(-400)}`,
		);
	return {
		vm: forked.vm,
		forkMs: forked.forkMs,
		cwd,
		...parseForkBase(result.stdout),
	};
}

/**
 * Exports a writer's work from its fork into the parent's checkout. Returns
 * null when the writer changed nothing.
 */
export async function transferWriterPatch(input: {
	readonly machines: WorkspaceMachines;
	readonly forkVm: WorkspaceId;
	readonly parentVm: WorkspaceId;
	readonly label: string;
	readonly base: string;
	readonly parentHead: string;
}): Promise<WriterPatch | null> {
	const { machines, forkVm, parentVm } = input;
	const [forkCwd, parentCwd] = await Promise.all(
		[forkVm, parentVm].map(async (vm) =>
			(await machines.readTextFile(vm, PROJECT_CWD_PATH))?.trim(),
		),
	);
	if (!forkCwd?.startsWith("/") || !parentCwd?.startsWith("/"))
		throw new Error("A repository path is unavailable.");
	const outDir = `/tmp/ytimesy-agent-export-${input.label}-${randomUUID()}`;
	const exported = await machines.exec(
		forkVm,
		writerExportScript({
			cwd: forkCwd,
			label: input.label,
			base: input.base,
			parentHead: input.parentHead,
			outDir,
		}),
		120_000,
	);
	if (exported.exitCode !== 0)
		throw new Error(
			`The writer's work could not be exported: ${exported.stderr.slice(-400)}`,
		);
	const read = (name: string) =>
		machines.readTextFile(forkVm, `${outDir}/${name}`);
	const [patch, numstat, sha256, bundle] = await Promise.all([
		read("patch"),
		read("numstat"),
		read("sha256"),
		read("bundle.b64"),
	]);
	if (!patch?.trim()) return null;
	const patchPayload = `/tmp/ytimesy-agent-patch-${randomUUID()}.patch`;
	await machines.writeTextFile(parentVm, patchPayload, patch);
	let bundlePayload: string | null = null;
	if (bundle && bundle.length <= MAX_BUNDLE_BASE64) {
		bundlePayload = `/tmp/ytimesy-agent-bundle-${randomUUID()}.b64`;
		await machines.writeTextFile(parentVm, bundlePayload, bundle);
	}
	const imported = await machines.exec(
		parentVm,
		parentImportScript({
			cwd: parentCwd,
			label: input.label,
			patchPayload,
			bundlePayload,
		}),
		120_000,
	);
	if (imported.exitCode !== 0)
		throw new Error(
			`The patch could not be stored in your checkout: ${imported.stderr.slice(-400)}`,
		);
	return {
		path: writerPatchPath(input.label),
		...parseNumstat(numstat ?? ""),
		sha256: (sha256 ?? "").trim(),
		ref: bundlePayload
			? writerPatchRef(input.label)
			: "(bundle too large; patch only)",
		base: input.base,
	};
}
