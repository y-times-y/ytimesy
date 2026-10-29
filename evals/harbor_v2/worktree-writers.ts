import type { ApiAgentEvent } from "../../src/domain/api-agent-event";
import type { WorkspaceId } from "../../src/domain/ids";
import { posixShellQuoted as quote } from "../../src/domain/posix-command";
import { publicationCommitAuthor } from "../../src/domain/publication";
import {
	overlappingWriters,
	type WriterPatch,
	writerPatchBlock,
	writerPatchRef,
} from "../../src/domain/subagent";
import {
	parseAddedFiles,
	parseNumstat,
	writerAddedFilesScript,
	writerExportScript,
	writerPatchExclusions,
} from "../../src/server/services/subagent-writer";
import type { WorkspaceMachines } from "../../src/server/services/workspace-machines";

/**
 * helpers=write-tree: the product's writer mechanic in one task container.
 * A product writer runs on a fork of its parent's VM (uncommitted work
 * included) and returns a patch and git ref; the builder reviews it
 * (`git diff <base> <ref>`), applies it with `git apply -3` and resolves
 * conflicts itself (src/server/services/subagent-writer.ts). Here:
 *
 * - Start: the builder's working state (tracked, untracked, not ignored) is
 *   committed off to the side as the writer's base (a temporary index and
 *   commit-tree: the builder's HEAD, index and branch stay as they are), and
 *   a git worktree on its own branch is checked out at that base. Ignored
 *   files (dependencies, build caches) are copied in, as a fork has them.
 *   A checkout that is not a git repository (most Terminal-Bench tasks) is
 *   made one first: one commit of everything, heavy directories and files
 *   over 20 MB excluded in .git/info/exclude; that .git is removed at the
 *   trial's end.
 * - Finish: the product's own export (writerAddedFilesScript and
 *   writerExportScript: scratch and large new files left out, the rest
 *   auto-committed), the patch stored outside the checkout and the ref at
 *   refs/ytimesy/agents/<label>, reachable from the builder's checkout (one
 *   .git). The builder gets the product's patch block (writerPatchBlock). A
 *   writer briefed again continues in its worktree; that round's patch is
 *   against the previous round's ref, so it holds only the new work.
 * - Trial end: what the builder did with each patch (its `git apply -3`
 *   commands and their conflicts, whether the patch is in the final tree,
 *   unmerged paths or conflict markers left), then the worktrees, branches
 *   and refs are removed.
 */

const GIT =
	"git -c user.name=ytimesy-agent -c user.email=agent@ytimesy.invalid";

/** Directories a fresh repository leaves out: dependencies, build output, caches. */
const HEAVY_DIRECTORIES = [
	".lake/",
	"node_modules/",
	"target/",
	"__pycache__/",
	".venv/",
	"venv/",
	".cache/",
	".mypy_cache/",
	".pytest_cache/",
	".ruff_cache/",
	"*.pyc",
];
const LARGE_FILE = "+20M";

const safe = (value: string) => value.replaceAll(/[^a-zA-Z0-9-]/g, "-");

export function worktreeRoot(trialId: string) {
	return `/tmp/ytimesy-writers/${safe(trialId)}`;
}

/** A ref- and branch-safe label for a writer session ("trial-1.2" -> "trial-1-2"). */
export function writerLabel(sessionId: string) {
	return safe(sessionId).slice(0, 80);
}

const WORKTREE_MARK = "ytimesy-worktree";

/**
 * Run in the builder's checkout: the writer's base and worktree. Prints
 * `ytimesy-worktree <created 0|1> <base> <parent head|none> <top> <prefix>`.
 */
export function worktreeStartScript(input: {
	readonly cwd: string;
	readonly path: string;
	readonly label: string;
}) {
	const author = publicationCommitAuthor({});
	const path = quote(input.path);
	const label = input.label;
	return [
		"set -e",
		`cd ${quote(input.cwd)}`,
		// Most task images ship without git (a product VM has it): as root,
		// install it with the image's package manager; otherwise fail.
		"if ! command -v git >/dev/null 2>&1; then",
		'  if [ "$(id -u)" = 0 ]; then',
		"    { if command -v apt-get >/dev/null; then apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends git; elif command -v dnf >/dev/null; then dnf install -y -q git-core; elif command -v apk >/dev/null; then apk add -q git; fi; } >/dev/null 2>&1 || true",
		"  fi",
		"  command -v git >/dev/null 2>&1 || { echo 'git is not installed and the trial user cannot install it' >&2; exit 1; }",
		"  echo ytimesy-installed-git",
		"fi",
		// A task image's non-root user in a root-owned checkout (/app mode 1777):
		// git refuses the repository as "dubious ownership" for every later
		// command, the builder's own `git apply -3` included.
		`if [ ! -O . ] && ! git config --global --get-all safe.directory 2>/dev/null | grep -qxF '*'; then git config --global --add safe.directory '*'; fi`,
		"created=0",
		"if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then",
		"  git init -q",
		"  created=1",
		// Files the trial user cannot read (an execute-only tool binary) cannot be indexed.
		`  { printf '%s\\n' ${HEAVY_DIRECTORIES.map(quote).join(" ")}; find . -path ./.git -prune -o -type f -size ${LARGE_FILE} -print | sed 's|^\\./|/|'; find . -path ./.git -prune -o -type f -print | while IFS= read -r f; do [ -r "$f" ] || printf '%s\\n' "\${f#.}"; done; } >> "$(git rev-parse --git-path info/exclude)"`,
		"fi",
		`git config user.email >/dev/null || git config user.email ${quote(author.email)}`,
		`git config user.name >/dev/null || git config user.name ${quote(author.name)}`,
		`if [ "$created" = 1 ]; then git add -A && ${GIT} commit -q --no-verify --allow-empty -m 'ytimesy base (Harbor bridge)'; fi`,
		"top=$(git rev-parse --show-toplevel)",
		"prefix=$(git rev-parse --show-prefix)",
		"parent_head=$(git rev-parse -q --verify HEAD || true)",
		'cd "$top"',
		"index_dir=$(mktemp -d)",
		'if [ -n "$parent_head" ]; then GIT_INDEX_FILE="$index_dir/index" git read-tree HEAD; fi',
		'GIT_INDEX_FILE="$index_dir/index" git add -A',
		'tree=$(GIT_INDEX_FILE="$index_dir/index" git write-tree)',
		'rm -rf "$index_dir"',
		`base=$(${GIT} commit-tree "$tree" \${parent_head:+-p "$parent_head"} -m ${quote(`ytimesy fork base (${label})`)})`,
		`git update-ref ${quote(`refs/ytimesy/bases/${label}`)} "$base"`,
		`rm -rf ${path} && mkdir -p "$(dirname ${path})"`,
		`git worktree add -q -B ${quote(`ytimesy/${label}`)} ${path} "$base"`,
		// Ignored files (dependencies, build caches) as a VM fork has them.
		`if ! { git ls-files -z --others --ignored --exclude-standard --directory | tar --null -T - -cf - | tar -C ${path} -xf -; } 2>/dev/null; then echo 'ytimesy: ignored files not copied' >&2; fi`,
		`echo "${WORKTREE_MARK} $created $base \${parent_head:-none} $top $prefix"`,
	].join("\n");
}

export function parseWorktreeStart(stdout: string) {
	const line = stdout
		.split("\n")
		.reverse()
		.find((entry) => entry.startsWith(`${WORKTREE_MARK} `));
	const [, created, base, parentHead, top, prefix = ""] = (line ?? "").split(
		" ",
	);
	if (!base || !/^[0-9a-f]{40,64}$/.test(base) || !top?.startsWith("/"))
		throw new Error("The writer's base commit could not be recorded.");
	return {
		createdRepo: created === "1",
		base,
		parentHead: parentHead === "none" ? null : (parentHead ?? null),
		top,
		prefix,
	};
}

/** Builder commands that apply a patch three-way, and their results. */
const APPLY_3WAY = /\bgit\b[^\n"]*?\bapply\b[^\n"]*?(?:\s-3\b|--3way)/;
const CONFLICTED = /Applied patch to '[^']*' with conflicts/g;

export type ApplyCommand = {
	readonly id: string;
	/** Writer labels whose patch path or ref the command names. */
	readonly writers: readonly string[];
	/** Files the command applied with conflicts (git's "with conflicts" lines). */
	readonly conflicts: number;
	readonly clean: boolean;
};

/**
 * The builder's `git apply -3` calls (a bash call or a run_code program)
 * and their outcomes: best effort, from the command text and its output.
 */
export function applyCommands(
	events: readonly ApiAgentEvent[],
	writers: readonly { label: string; paths: readonly string[] }[],
): ApplyCommand[] {
	const results = new Map<string, string>();
	for (const event of events)
		if (event.type === "tool-result")
			results.set(
				event.id,
				typeof event.output === "string"
					? event.output
					: JSON.stringify(event.output ?? ""),
			);
	const found: ApplyCommand[] = [];
	for (const event of events) {
		if (event.type !== "tool-call") continue;
		const text =
			typeof event.input === "string"
				? event.input
				: JSON.stringify(event.input ?? "");
		if (!APPLY_3WAY.test(text)) continue;
		const output = results.get(event.id) ?? "";
		const conflicts = output.match(CONFLICTED)?.length ?? 0;
		found.push({
			id: event.id,
			writers: writers
				.filter(
					(writer) =>
						writer.paths.some((path) => text.includes(path)) ||
						text.includes(writerPatchRef(writer.label)),
				)
				.map((writer) => writer.label),
			conflicts,
			clean: conflicts === 0 && !/error:|exit code [1-9]/i.test(output),
		});
	}
	return found;
}

type Round = {
	base: string;
	ref: string;
	head: string | null;
	patch: WriterPatch | null;
	patchBytes: number;
	failure?: string;
	/** Set at the trial's end: the patch is in the builder's final tree. */
	inFinal?: boolean;
};

type Writer = {
	sessionId: string;
	label: string;
	path: string;
	cwd: string;
	base: string;
	parentHead: string | null;
	rounds: Round[];
	/** The base of the next round: the previous round's head. */
	next: string;
};

export type WorktreeWritersTrace = {
	createdRepo: boolean;
	writers: {
		sessionId: string;
		label: string;
		worktree: string;
		base: string;
		parentHead: string | null;
		rounds: (Omit<Round, "patch"> & {
			path: string | null;
			files: readonly string[];
			added: number;
			removed: number;
			excluded: number;
			applyCommands: number;
			conflictedApplies: number;
		})[];
	}[];
	/** Every `git apply -3` the builder ran, with the files git reported conflicted. */
	applyCommands: number;
	applyConflicts: number;
	/** Left in the builder's checkout at the trial's end (never silently). */
	unmergedAtEnd: string[];
	conflictMarkersAtEnd: string[];
	cleanup: { ok: boolean; detail: string } | null;
	failures: string[];
};

export function worktreeWriters(input: {
	machines: WorkspaceMachines;
	vm: WorkspaceId;
	/** The builder's checkout. */
	cwd: string;
	trialId: string;
	log?: (line: string) => void;
}) {
	const { machines, vm } = input;
	const log = input.log ?? (() => {});
	const root = worktreeRoot(input.trialId);
	const writers = new Map<string, Writer>();
	let createdRepo = false;
	let top: string | null = null;
	const failures: string[] = [];
	const result: WorktreeWritersTrace = {
		createdRepo: false,
		writers: [],
		applyCommands: 0,
		applyConflicts: 0,
		unmergedAtEnd: [],
		conflictMarkersAtEnd: [],
		cleanup: null,
		failures,
	};
	// One git operation on the shared repository at a time (two writers
	// starting at once would both init it).
	let chain: Promise<unknown> = Promise.resolve();
	const serial = <T>(work: () => Promise<T>): Promise<T> => {
		const next = chain.then(work, work);
		chain = next.catch(() => {});
		return next;
	};
	const exec = async (command: string, timeoutMs: number) =>
		machines.exec(vm, command, timeoutMs);

	/** The writer's worktree, made on its first round. */
	const open = (sessionId: string) =>
		serial(async () => {
			const existing = writers.get(sessionId);
			if (existing) return { cwd: existing.cwd, label: existing.label };
			const label = writerLabel(sessionId);
			const path = `${root}/${label}/checkout`;
			const started = await exec(
				worktreeStartScript({ cwd: input.cwd, path, label }),
				600_000,
			);
			if (started.exitCode !== 0) {
				// Recorded: a writer that never started is otherwise absent from the trace.
				const failure = `its worktree could not be made: ${(started.stderr || started.stdout).slice(-400)}`;
				failures.push(`${sessionId}: ${failure}`);
				throw new Error(failure);
			}
			const parsed = parseWorktreeStart(started.stdout);
			createdRepo ||= parsed.createdRepo;
			top = parsed.top;
			const cwd = parsed.prefix
				? `${path}/${parsed.prefix.replace(/\/$/, "")}`
				: path;
			writers.set(sessionId, {
				sessionId,
				label,
				path,
				cwd,
				base: parsed.base,
				parentHead: parsed.parentHead,
				rounds: [],
				next: parsed.base,
			});
			log(
				`writer ${sessionId}: worktree ${path} at ${parsed.base.slice(0, 12)}${parsed.createdRepo ? " (made the checkout a git repository)" : ""}${started.stdout.includes("ytimesy-installed-git") ? " (installed git)" : ""}`,
			);
			return { cwd, label };
		});

	/** After a round: the product's export, the patch and ref, the builder's patch block. */
	const finish = (sessionId: string, named: string) =>
		serial(async (): Promise<string> => {
			const writer = writers.get(sessionId);
			if (!writer) return writerPatchBlock(null, [], "it has no worktree");
			const round = writer.rounds.length + 1;
			const base = writer.next;
			const ref = writerPatchRef(writer.label);
			const out = `${root}/${writer.label}/export-${round}`;
			const patchPath = `${root}/patches/${writer.label}${round > 1 ? `-r${round}` : ""}.patch`;
			const record: Round = {
				base,
				ref,
				head: null,
				patch: null,
				patchBytes: 0,
			};
			writer.rounds.push(record);
			try {
				const listed = await exec(
					writerAddedFilesScript({ cwd: writer.path, base }),
					120_000,
				);
				if (listed.exitCode !== 0)
					throw new Error(
						`the writer's new files could not be listed: ${listed.stderr.slice(-300)}`,
					);
				const left = writerPatchExclusions(
					parseAddedFiles(listed.stdout),
					named,
				);
				const excludeFile = left.length
					? `${root}/${writer.label}/exclude-${round}`
					: undefined;
				if (excludeFile)
					await machines.writeTextFile(
						vm,
						excludeFile,
						left.map((file) => `:(literal)${file.path}\n`).join(""),
					);
				const exported = await exec(
					[
						writerExportScript({
							cwd: writer.path,
							label: writer.label,
							base,
							parentHead: base,
							outDir: out,
							excludeFile,
						}),
						`mkdir -p ${quote(`${root}/patches`)}`,
						`cp ${quote(`${out}/patch`)} ${quote(patchPath)}`,
						`git -C ${quote(input.cwd)} update-ref ${quote(ref)} "$(cat ${quote(`${out}/head`)})"`,
						`echo "ytimesy-export $(cat ${quote(`${out}/head`)}) $(cat ${quote(`${out}/sha256`)}) $(wc -c < ${quote(`${out}/patch`)})"`,
						`cat ${quote(`${out}/numstat`)}`,
					].join("\n"),
					120_000,
				);
				if (exported.exitCode !== 0)
					throw new Error(
						`the writer's work could not be exported: ${exported.stderr.slice(-300)}`,
					);
				const at = exported.stdout.indexOf("ytimesy-export ");
				if (at < 0) throw new Error("the writer's export printed no result");
				const [mark, ...numstat] = exported.stdout.slice(at).split("\n");
				const [, head, sha256, bytes] = (mark ?? "").trim().split(/\s+/);
				record.head = head ?? null;
				record.patchBytes = Number(bytes) || 0;
				if (head) writer.next = head;
				const stats = parseNumstat(numstat.join("\n"));
				const excluded = left.length
					? {
							count: left.length,
							bytes: left.reduce((sum, file) => sum + file.bytes, 0),
							paths: [...left]
								.sort((a, b) => b.bytes - a.bytes)
								.slice(0, 8)
								.map((file) => file.path),
						}
					: undefined;
				if (record.patchBytes > 0)
					record.patch = {
						path: patchPath,
						...stats,
						sha256: sha256 ?? "",
						ref,
						base,
						...(excluded ? { excluded } : {}),
					};
				log(
					`writer ${sessionId} round ${round}: ${record.patch ? `patch ${stats.files.length} files +${stats.added} -${stats.removed} (${record.patchBytes} bytes)` : "no changes"}`,
				);
			} catch (error) {
				record.failure = error instanceof Error ? error.message : String(error);
				failures.push(`${sessionId}: ${record.failure}`);
				log(`writer ${sessionId}: ${record.failure}`);
			}
			const siblings = [...writers.values()]
				.filter((other) => other !== writer)
				.map((other) => ({
					label: other.label,
					files: other.rounds.flatMap((entry) => entry.patch?.files ?? []),
				}));
			return writerPatchBlock(
				record.patch,
				record.patch ? overlappingWriters(record.patch.files, siblings) : [],
				record.failure,
			);
		});

	/**
	 * At the trial's end: what the builder did with the patches (from its
	 * events and the final tree), then the worktrees, branches and refs go.
	 */
	const close = (builderEvents: readonly ApiAgentEvent[]) =>
		serial(async () => {
			const list = [...writers.values()];
			result.createdRepo = createdRepo;
			if (!list.length) return result;
			const commands = applyCommands(
				builderEvents,
				list.map((writer) => ({
					label: writer.label,
					paths: writer.rounds.flatMap((round) =>
						round.patch ? [round.patch.path] : [],
					),
				})),
			);
			result.applyCommands = commands.length;
			result.applyConflicts = commands.reduce(
				(sum, command) => sum + command.conflicts,
				0,
			);
			const checkout = top ?? input.cwd;
			const patches = list.flatMap((writer) =>
				writer.rounds.flatMap((round) => (round.patch ? [round.patch] : [])),
			);
			const files = [...new Set(patches.flatMap((patch) => patch.files))];
			const state = await exec(
				[
					`cd ${quote(checkout)} || exit 0`,
					"echo ytimesy-unmerged",
					"git ls-files -u 2>/dev/null | cut -f2 | sort -u",
					"echo ytimesy-markers",
					...(files.length
						? [
								`grep -lE '^(<<<<<<<|>>>>>>>)( |$)' -- ${files.map(quote).join(" ")} 2>/dev/null || true`,
							]
						: []),
					"echo ytimesy-final",
					...patches.map(
						(patch) =>
							`if git apply --check -R ${quote(patch.path)} >/dev/null 2>&1; then echo "in ${patch.path}"; else echo "out ${patch.path}"; fi`,
					),
				].join("\n"),
				60_000,
			).catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));
			const section = (name: string, nextName: string) => {
				const text = state.stdout;
				const from = text.indexOf(`ytimesy-${name}\n`);
				if (from < 0) return [];
				const start = from + `ytimesy-${name}\n`.length;
				const end = text.indexOf(`ytimesy-${nextName}\n`, start);
				return text
					.slice(start, end < 0 ? undefined : end)
					.split("\n")
					.filter(Boolean);
			};
			result.unmergedAtEnd = section("unmerged", "markers");
			result.conflictMarkersAtEnd = section("markers", "final");
			const final = new Map(
				section("final", "end").map((line) => [
					line.slice(line.indexOf(" ") + 1),
					line.startsWith("in "),
				]),
			);
			if (result.unmergedAtEnd.length || result.conflictMarkersAtEnd.length)
				log(
					`warning: the builder's checkout ends with ${result.unmergedAtEnd.length} unmerged paths and conflict markers in ${result.conflictMarkersAtEnd.length} files: ${[...result.unmergedAtEnd, ...result.conflictMarkersAtEnd].slice(0, 10).join(", ")}`,
				);
			result.writers = list.map((writer) => ({
				sessionId: writer.sessionId,
				label: writer.label,
				worktree: writer.path,
				base: writer.base,
				parentHead: writer.parentHead,
				rounds: writer.rounds.map((round) => {
					const path = round.patch?.path ?? null;
					const mine = commands.filter((command) =>
						path ? command.writers.includes(writer.label) : false,
					);
					return {
						base: round.base,
						ref: round.ref,
						head: round.head,
						patchBytes: round.patchBytes,
						...(round.failure ? { failure: round.failure } : {}),
						...(path ? { inFinal: final.get(path) ?? false } : {}),
						path,
						files: round.patch?.files ?? [],
						added: round.patch?.added ?? 0,
						removed: round.patch?.removed ?? 0,
						excluded: round.patch?.excluded?.count ?? 0,
						applyCommands: mine.length,
						conflictedApplies: mine.filter((command) => command.conflicts > 0)
							.length,
					};
				}),
			}));
			const removed = await exec(
				[
					`cd ${quote(checkout)} || exit 1`,
					// rm, then `git worktree prune`, then the branches (a branch still
					// checked out in a worktree is not deleted): `git worktree remove`
					// took minutes on a worktree with a copied 7 GB Lean .lake (rm: 2 s).
					...list.map((writer) => `rm -rf ${quote(writer.path)}`),
					"git worktree prune",
					...list.flatMap((writer) => [
						`git branch -D ${quote(`ytimesy/${writer.label}`)} >/dev/null 2>&1 || true`,
						`git update-ref -d ${quote(writerPatchRef(writer.label))} 2>/dev/null || true`,
						`git update-ref -d ${quote(`refs/ytimesy/bases/${writer.label}`)} 2>/dev/null || true`,
					]),
					`rm -rf ${quote(root)}`,
					// A repository the bridge made only for its writers goes too.
					...(createdRepo ? ["rm -rf .git"] : []),
					"echo ytimesy-cleaned",
				].join("\n"),
				120_000,
			).catch((error: unknown) => ({
				exitCode: 1,
				stdout: "",
				stderr: error instanceof Error ? error.message : String(error),
			}));
			result.cleanup = {
				ok:
					removed.exitCode === 0 && removed.stdout.includes("ytimesy-cleaned"),
				detail: (removed.stderr || "").slice(-300),
			};
			if (!result.cleanup.ok)
				log(
					`warning: writer worktrees not fully removed: ${result.cleanup.detail}`,
				);
			return result;
		});

	return {
		open,
		finish,
		close,
		/** The trace so far (complete after close). */
		trace: () => result,
	};
}
