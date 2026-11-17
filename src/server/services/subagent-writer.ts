import { randomUUID } from "node:crypto";
import type { WorkspaceId } from "#/domain/ids";
import { posixShellQuoted as quote } from "#/domain/posix-command";
import { publicationCommitAuthor } from "#/domain/publication";
import {
	excludedFilesNote,
	type WriterPatch,
	type WriterPatchExclusions,
	writerPatchExclusion,
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

/**
 * Run in the fresh fork: commit what the parent had (uncommitted work
 * included). The fork's checkout gets the identity the builder's turn commits
 * use (automaticTurnCommitArgv), unless the repository already names one, so
 * the writer's own `git commit` does not fail for want of an author.
 */
export function forkBaseScript(cwd: string) {
	const author = publicationCommitAuthor({});
	return [
		"set -e",
		`cd ${quote(cwd)}`,
		`git config user.email >/dev/null || git config user.email ${quote(author.email)}`,
		`git config user.name >/dev/null || git config user.name ${quote(author.name)}`,
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

/**
 * Run in the fork at the end, before the export: stage everything git does
 * not ignore and list the files added since the fork-base (numstat, then
 * each one's size in the same order).
 */
export function writerAddedFilesScript(input: {
	readonly cwd: string;
	readonly base: string;
}) {
	const base = quote(input.base);
	return [
		"set -e",
		`cd ${quote(input.cwd)}`,
		"git add -A",
		`git -c core.quotePath=false diff --cached --numstat --diff-filter=A ${base}`,
		`echo ${ADDED_SIZES}`,
		`git diff --cached --raw --no-abbrev --diff-filter=A ${base} | cut -d' ' -f4 | git cat-file --batch-check='%(objectsize)'`,
	].join("\n");
}

const ADDED_SIZES = "ytimesy-added-sizes";

/** Files added since the fork-base, from writerAddedFilesScript's output. */
export function parseAddedFiles(stdout: string) {
	const [numstat = "", sizes = ""] = stdout.split(`${ADDED_SIZES}\n`);
	const rows = numstat.split("\n").filter((line) => line.includes("\t"));
	const bytes = sizes.split("\n").filter(Boolean);
	// Out of step (a path git had to quote, a gitlink): keep everything.
	if (rows.length !== bytes.length) return [];
	return rows.map((row, index) => {
		const [plus, minus, ...path] = row.split("\t");
		return {
			path: path.join("\t"),
			binary: plus === "-" && minus === "-",
			bytes: Number(bytes[index]) || 0,
		};
	});
}

/**
 * The added files a patch leaves out (see writerPatchExclusion). A path git
 * quoted is kept, since it cannot be named back to git exactly.
 */
export function writerPatchExclusions(
	added: ReturnType<typeof parseAddedFiles>,
	named: string,
) {
	return added.filter(
		(file) =>
			!file.path.startsWith('"') && writerPatchExclusion(file, named) !== null,
	);
}

/** Run in the fork at the end: auto-commit, then write the patch, stats and bundle. */
export function writerExportScript(input: {
	readonly cwd: string;
	readonly label: string;
	readonly base: string;
	readonly parentHead: string;
	readonly outDir: string;
	/** A pathspec file of added files to keep out of the commit (they stay on disk). */
	readonly excludeFile?: string;
}) {
	const out = quote(input.outDir);
	return [
		"set -e",
		`cd ${quote(input.cwd)}`,
		"git add -A",
		...(input.excludeFile
			? [
					`git rm -q --cached --ignore-unmatch --pathspec-from-file=${quote(input.excludeFile)}`,
					`rm -f ${quote(input.excludeFile)}`,
				]
			: []),
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

const PATCH_PATH_MARKER = "ytimesy-patch-path:";

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
		// The absolute path: the parent's commands may run as another user
		// (a hard-set task container runs them as root), where ~ is not this home.
		`printf '${PATCH_PATH_MARKER}%s\\n' "$(cd ${directory} && pwd -P)/${input.label}.patch"`,
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
 * Applies a writer's stored patch to its parent's working tree (Y's thread,
 * harness variant y=on): the runtime integrates, so Y never runs git. Only a
 * patch that applies cleanly is applied; otherwise nothing changes and the
 * reason is returned, so a conflict never leaves markers to be committed.
 */
export async function applyWriterPatchToParent(input: {
	readonly machines: WorkspaceMachines;
	readonly parentVm: WorkspaceId;
	readonly patchPath: string;
}): Promise<
	| { readonly applied: true }
	| { readonly applied: false; readonly reason: string }
> {
	const cwd = (
		await input.machines.readTextFile(input.parentVm, PROJECT_CWD_PATH)
	)?.trim();
	if (!cwd?.startsWith("/"))
		return {
			applied: false,
			reason: "the thread's repository path is unavailable",
		};
	const patchFile = quote(input.patchPath);
	const result = await input.machines.exec(
		input.parentVm,
		[
			`cd ${quote(cwd)}`,
			"git add -A",
			`git apply --index --check ${patchFile}`,
			`git apply --index ${patchFile}`,
		].join(" && "),
		120_000,
	);
	return result.exitCode === 0
		? { applied: true }
		: {
				applied: false,
				reason:
					(result.stderr || result.stdout).trim().slice(-400) ||
					"it does not apply cleanly to the thread's current changes",
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
	/** The writer's brief and messages: a file they name is a deliverable. */
	readonly named?: string;
}): Promise<WriterPatch | null> {
	const { machines, forkVm, parentVm } = input;
	const [forkCwd, parentCwd] = await Promise.all(
		[forkVm, parentVm].map(async (vm) =>
			(await machines.readTextFile(vm, PROJECT_CWD_PATH))?.trim(),
		),
	);
	if (!forkCwd?.startsWith("/") || !parentCwd?.startsWith("/"))
		throw new Error("A repository path is unavailable.");
	const listed = await machines.exec(
		forkVm,
		writerAddedFilesScript({ cwd: forkCwd, base: input.base }),
		120_000,
	);
	if (listed.exitCode !== 0)
		throw new Error(
			`The writer's new files could not be listed: ${listed.stderr.slice(-400)}`,
		);
	const left = writerPatchExclusions(
		parseAddedFiles(listed.stdout),
		input.named ?? "",
	);
	let excludeFile: string | undefined;
	if (left.length) {
		excludeFile = `/tmp/ytimesy-agent-exclude-${randomUUID()}`;
		await machines.writeTextFile(
			forkVm,
			excludeFile,
			left.map((file) => `:(literal)${file.path}\n`).join(""),
		);
	}
	const excluded: WriterPatchExclusions | undefined = left.length
		? {
				count: left.length,
				bytes: left.reduce((sum, file) => sum + file.bytes, 0),
				paths: [...left]
					.sort((a, b) => b.bytes - a.bytes)
					.slice(0, 8)
					.map((file) => file.path),
			}
		: undefined;
	const outDir = `/tmp/ytimesy-agent-export-${input.label}-${randomUUID()}`;
	const exported = await machines.exec(
		forkVm,
		writerExportScript({
			cwd: forkCwd,
			label: input.label,
			base: input.base,
			parentHead: input.parentHead,
			outDir,
			excludeFile,
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
	if (!patch?.trim()) {
		if (excluded)
			throw new Error(
				`the writer changed nothing deliberate; left out ${excludedFilesNote(excluded)}`,
			);
		return null;
	}
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
		path:
			imported.stdout
				.split("\n")
				.find((line) => line.startsWith(PATCH_PATH_MARKER))
				?.slice(PATCH_PATH_MARKER.length)
				.trim() || writerPatchPath(input.label),
		...parseNumstat(numstat ?? ""),
		sha256: (sha256 ?? "").trim(),
		ref: bundlePayload
			? writerPatchRef(input.label)
			: "(bundle too large; patch only)",
		base: input.base,
		...(excluded ? { excluded } : {}),
	};
}
