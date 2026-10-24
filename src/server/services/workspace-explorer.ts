import { posix } from "node:path";
import { Effect } from "effect";
import {
	filePreviewKind,
	type WorkspaceFilePreview,
} from "#/domain/file-preview";
import {
	parseWorkspaceDiffOutput,
	WORKSPACE_DIFF_BYTE_LIMIT,
	WORKSPACE_DIFF_TRUNCATED_MARKER,
} from "#/domain/git-diff";
import { gitIndexPaths } from "#/domain/git-index";
import { WorkspaceId } from "#/domain/ids";
import { posixShellQuoted } from "#/domain/posix-command";
import { projectCheckoutPath } from "#/domain/project-checkout";
import {
	type ProjectFileRoot,
	resolveProjectFile,
} from "#/domain/project-files";
import { projectFolderName, repositoriesForProject } from "#/domain/projects";
import type { FileChangeEntry } from "#/domain/session-item";
import {
	projectCommandFromFile,
	type SlashCommand,
} from "#/domain/slash-command";
import {
	parseWorkspaceExplorerListing,
	type WorkspaceExplorerListing,
	type WorkspaceSourceFile,
	type WorkspaceSourceWrite,
	workspaceSourceText,
	workspaceSourceWriteText,
} from "#/domain/workspace-explorer";
import {
	firstWorkspaceFilePath,
	workspaceExplorerTree,
} from "#/domain/workspace-file-tree";
import { PROJECT_CWD_PATH } from "#/server/adapters/freestyle/clone-project";
import { agentSessionMetadataForOwner } from "../adapters/agent-sessions";
import { projectForOwner } from "../adapters/projects";
import { peekAgentSessionMachine } from "./agent-session-machine";
import { filePreviewCommand } from "./file-preview-command";
import type { WorkspaceMachines } from "./workspace-machines";

export type ExplorerScope = {
	readonly userId: string;
	readonly projectId?: string;
	readonly sessionId?: string;
};

const READ_PROJECT_COMMANDS = `import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
found = []
for folder in ('.claude/commands', '.agents/commands'):
    base = root / folder
    if not base.is_dir() or base.is_symlink():
        continue
    for path in sorted(base.glob('*.md'))[:50]:
        if path.is_file() and not path.is_symlink():
            found.append({'path': f'{folder}/{path.name}', 'text': path.read_bytes()[:16000].decode('utf-8', 'replace')})
print(json.dumps(found[:50]))`;

/** Repository-defined slash commands, read without starting a paused VM. */
export function listProjectCommands(
	machines: WorkspaceMachines,
	scope: ExplorerScope,
): Effect.Effect<SlashCommand[]> {
	return withRunningCheckout(machines, scope, (workspaceId, root) =>
		root
			? Effect.tryPromise(() =>
					machines.exec(
						workspaceId,
						`python3 -c ${posixShellQuoted(READ_PROJECT_COMMANDS)} ${posixShellQuoted(root)}`,
						15_000,
					),
				).pipe(
					Effect.map((result) => {
						const files = JSON.parse(result.stdout) as {
							path: string;
							text: string;
						}[];
						const commands = new Map<string, SlashCommand>();
						for (const file of files) {
							const command = projectCommandFromFile(file.path, file.text);
							if (command && !commands.has(command.trigger))
								commands.set(command.trigger, command);
						}
						return [...commands.values()];
					}),
					Effect.catchAll(() => Effect.succeed([] as SlashCommand[])),
				)
			: Effect.succeed([] as SlashCommand[]),
	).pipe(Effect.map((commands) => commands ?? []));
}

/**
 * Lists the checkout without starting a paused VM, and reads the file Files
 * opens with it (`open`, or the tree's first file) so the view needs one call.
 * A running machine lists with git; a paused one is listed from its git index,
 * read off its disk without waking it, and reported as asleep. Files the chat
 * added and never staged are missing there until it wakes; Files adds the
 * chat's own changes to the tree.
 */
export function listWorkspaceExplorer(
	machines: WorkspaceMachines,
	scope: ExplorerScope,
	open?: string,
): Effect.Effect<WorkspaceExplorerListing> {
	const list = (reuse: boolean) =>
		Effect.gen(function* () {
			const checkout = yield* findCheckout(machines, scope, { reuse });
			if (checkout === "none")
				return { ...emptyListing(), machine: "none" as const };
			if (!checkout) return emptyListing();
			const { workspaceId, roots, running } = checkout;
			const readOpened = (path: string | undefined) =>
				path && filePreviewKind(path) !== "image"
					? readCheckoutFile(machines, checkout, path)
					: Effect.succeed(null);
			const listed = running
				? listRunningCheckout(machines, workspaceId, roots)
				: listCheckoutIndex(machines, workspaceId, roots);
			const [listing, early] = yield* Effect.all(
				[listed, readOpened(open?.trim() || undefined)],
				{ concurrency: "unbounded" },
			);
			if (!listing?.paths.length && checkout.reused) return null;
			if (!listing)
				return {
					...emptyListing(),
					machine: running ? undefined : ("asleep" as const),
				};
			const first = open?.trim()
				? undefined
				: firstWorkspaceFilePath(workspaceExplorerTree(listing.paths));
			const opened = early ?? (yield* readOpened(first));
			return {
				...listing,
				...(running ? {} : { machine: "asleep" as const }),
				opened,
			};
		});
	return list(true).pipe(
		// A remembered machine that lists nothing may be gone: look the chat up again.
		Effect.flatMap((listing) =>
			listing ? Effect.succeed(listing) : list(false),
		),
		Effect.map((listing) => listing ?? emptyListing()),
		Effect.catchAll(() => Effect.succeed(emptyListing())),
	);
}

/**
 * Lists a running checkout with git (tracked and untracked files). A guest
 * that has just woken can take many seconds to answer its first command;
 * past a few seconds, or on failure, the git index stands in, as for a
 * paused machine.
 */
function listRunningCheckout(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	roots: readonly ProjectFileRoot[],
): Effect.Effect<WorkspaceExplorerListing | null> {
	if (roots.length === 0) return Effect.succeed(null);
	const prefixed = roots.length > 1;
	const command = roots
		.map((root) =>
			prefixed
				? `git -C ${posixShellQuoted(root.directory)} ls-files -co --exclude-standard | while IFS= read -r file; do printf '%s/%s\\n' ${posixShellQuoted(root.name)} "$file"; done`
				: `git -C ${posixShellQuoted(root.directory)} ls-files -co --exclude-standard`,
		)
		.join("\n");
	return Effect.tryPromise(() =>
		machines.exec(workspaceId, `bash -lc ${posixShellQuoted(command)}`, 20_000),
	).pipe(
		Effect.map((result) => ({
			...parseWorkspaceExplorerListing(result.stdout),
			root: prefixed ? posix.dirname(roots[0].directory) : roots[0].directory,
		})),
		Effect.timeout(RUNNING_LIST_WAIT),
		Effect.catchAll(() =>
			listCheckoutIndex(machines, workspaceId, roots).pipe(
				Effect.map((listing) => listing ?? emptyListing()),
			),
		),
	);
}

const RUNNING_LIST_WAIT = "3 seconds";

/** The tracked files of a checkout, from each repository's git index on the machine's disk. */
function listCheckoutIndex(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	roots: readonly ProjectFileRoot[],
): Effect.Effect<WorkspaceExplorerListing | null> {
	const readFile = machines.readFile;
	if (!readFile || roots.length === 0) return Effect.succeed(null);
	return Effect.tryPromise(() =>
		Promise.all(
			roots.map(async (root) => {
				const bytes = await readFile(
					workspaceId,
					posix.join(root.directory, ".git/index"),
				);
				const paths = bytes ? gitIndexPaths(bytes, 4000) : null;
				if (!paths) throw new Error("No readable git index.");
				return roots.length > 1
					? paths.map((path) => `${root.name}/${path}`)
					: paths;
			}),
		),
	).pipe(
		Effect.map((lists) => {
			const listing = parseWorkspaceExplorerListing(lists.flat().join("\n"));
			return {
				...listing,
				root:
					roots.length > 1
						? posix.dirname(roots[0].directory)
						: roots[0].directory,
			};
		}),
		Effect.catchAll(() => Effect.succeed(null)),
	);
}

/**
 * Reads one file of the checkout. The provider reads a paused machine's disk
 * without starting it, so this works whether or not the machine is awake.
 */
export function readWorkspaceExplorerFile(
	machines: WorkspaceMachines,
	scope: ExplorerScope,
	requested: string,
): Effect.Effect<WorkspaceSourceFile | null> {
	return readWorkspaceExplorerFiles(machines, scope, [requested]).pipe(
		Effect.map(([file]) => file ?? null),
	);
}

/** Reads several files of the checkout with one lookup of the chat's machine. */
export function readWorkspaceExplorerFiles(
	machines: WorkspaceMachines,
	scope: ExplorerScope,
	requested: readonly string[],
): Effect.Effect<(WorkspaceSourceFile | null)[]> {
	const wanted = requested.map((path) => path.trim());
	const none = wanted.map(() => null);
	if (!wanted.some(Boolean)) return Effect.succeed(none);
	const read = (reuse: boolean) =>
		findCheckout(machines, scope, { askRunning: false, reuse }).pipe(
			Effect.flatMap((checkout) =>
				checkout && checkout !== "none"
					? Effect.all(
							wanted.map((want) =>
								want
									? readCheckoutFile(machines, checkout, want)
									: Effect.succeed(null),
							),
							{ concurrency: "unbounded" },
						).pipe(Effect.map((files) => ({ files, reused: checkout.reused })))
					: Effect.succeed({ files: none, reused: false }),
			),
		);
	return read(true).pipe(
		// A remembered machine that reads nothing may be gone: look the chat up again.
		Effect.flatMap(({ files, reused }) =>
			files.some(Boolean) || !reused
				? Effect.succeed(files)
				: read(false).pipe(Effect.map((again) => again.files)),
		),
		Effect.catchAll(() => Effect.succeed(none)),
	);
}

function readCheckoutFile(
	machines: WorkspaceMachines,
	checkout: Checkout,
	want: string,
): Effect.Effect<WorkspaceSourceFile | null> {
	const path = resolveProjectFile(checkout.roots, want)?.path;
	if (!path) return Effect.succeed(null);
	return Effect.tryPromise(() =>
		machines.readTextFile(checkout.workspaceId, path),
	).pipe(
		Effect.map((contents) => {
			const text = workspaceSourceText(contents);
			return text == null ? null : { path: want, text };
		}),
		Effect.catchAll(() => Effect.succeed(null)),
	);
}

export function writeWorkspaceExplorerFile(
	machines: WorkspaceMachines,
	scope: ExplorerScope,
	requested: string,
	contents: string,
): Effect.Effect<WorkspaceSourceWrite> {
	const want = requested.trim();
	const text = workspaceSourceWriteText(contents);
	if (!want || text == null) {
		return Effect.succeed<WorkspaceSourceWrite>({
			ok: false,
			reason: "invalid",
		});
	}
	return withRunningCheckout(machines, scope, (workspaceId, _root, roots) => {
		const path = resolveProjectFile(roots, want)?.path;
		if (!path)
			return Effect.succeed<WorkspaceSourceWrite>({
				ok: false,
				reason: "invalid",
			});
		return Effect.tryPromise(() =>
			machines.writeTextFile(workspaceId, path, text),
		).pipe(
			Effect.map((): WorkspaceSourceWrite => ({ ok: true, path: want })),
			Effect.catchAll(() =>
				Effect.succeed<WorkspaceSourceWrite>({ ok: false, reason: "failed" }),
			),
		);
	}).pipe(
		Effect.map(
			(result): WorkspaceSourceWrite =>
				result ?? { ok: false, reason: "asleep" },
		),
	);
}

export function readWorkspaceFilePreview(
	machines: WorkspaceMachines,
	scope: ExplorerScope,
	path: string,
	revision: "head" | "working",
): Effect.Effect<WorkspaceFilePreview> {
	return withRunningCheckout(machines, scope, (id, _root, roots) => {
		const file = resolveProjectFile(roots, path);
		if (!file)
			return Effect.succeed<WorkspaceFilePreview>({
				kind: "unavailable",
				reason: "Checkout is unavailable.",
			});
		return Effect.tryPromise(async (): Promise<WorkspaceFilePreview> => {
			const output = await machines.exec(
				id,
				filePreviewCommand(file.root, file.relative, revision),
				25_000,
			);
			const result = JSON.parse(output.stdout);
			if (result.kind === "text" && typeof result.text === "string")
				return { kind: "text", text: result.text };
			if (
				result.kind === "image" &&
				typeof result.dataUrl === "string" &&
				/^data:image\/(png|jpeg|gif|webp|x-icon|avif);base64,[A-Za-z0-9+/=]+$/.test(
					result.dataUrl,
				)
			)
				return { kind: "image", dataUrl: result.dataUrl };
			return {
				kind: "unavailable",
				reason:
					typeof result.reason === "string"
						? result.reason
						: "Preview unavailable.",
			};
		}).pipe(
			Effect.catchAll(() =>
				Effect.succeed<WorkspaceFilePreview>({
					kind: "unavailable",
					reason: "Could not read the preview.",
				}),
			),
		);
	}).pipe(
		Effect.map(
			(result) =>
				result ?? {
					kind: "unavailable" as const,
					reason: "Workspace is unavailable.",
				},
		),
	);
}

/**
 * Everything the chat changed against the branch it started from: committed,
 * staged, unstaged and new files, read from git in the workspace. Null when the
 * machine is asleep (it is never started for this).
 */
export function readWorkspaceGitChanges(
	machines: WorkspaceMachines,
	scope: ExplorerScope,
): Effect.Effect<FileChangeEntry[] | null> {
	return withRunningCheckout(machines, scope, (workspaceId, _root, roots) =>
		Effect.gen(function* () {
			const session = scope.sessionId
				? yield* Effect.tryPromise(() =>
						agentSessionMetadataForOwner(
							scope.userId,
							scope.sessionId as string,
						),
					).pipe(Effect.catchAll(() => Effect.succeed(null)))
				: null;
			const base = session?.baseBranch || session?.selectedBranch || "";
			const changes: FileChangeEntry[] = [];
			for (const [index, root] of roots.entries()) {
				const result = yield* Effect.tryPromise(() =>
					machines.exec(
						workspaceId,
						`bash -c ${posixShellQuoted(gitChangesScript(root.directory, index === 0 ? base : ""))}`,
						20_000,
					),
				);
				if (result.exitCode !== 0) return null;
				changes.push(
					...parseWorkspaceDiffOutput(
						result.stdout,
						roots.length > 1 ? `${root.name}/` : "",
					).changes,
				);
			}
			return changes;
		}).pipe(Effect.catchAll(() => Effect.succeed(null))),
	);
}

/** Diff against the merge base with the chat's base branch, plus untracked files. */
export function gitChangesScript(directory: string, base: string) {
	return `cd ${posixShellQuoted(directory)} || exit 3
base=""
for ref in ${base ? `${posixShellQuoted(`origin/${base}`)} ${posixShellQuoted(base)} ` : ""}'@{upstream}' origin/HEAD; do
  base=$(git merge-base HEAD "$ref" 2>/dev/null) && break
done
[ -n "$base" ] || base=HEAD
out=$(mktemp) || exit 4
failed=$(mktemp) || exit 4
trap 'rm -f "$out" "$failed"' EXIT
# Capping with head stops the writers with SIGPIPE (status 141), which is not
# a failure; any other failing status is, so the panel never shows a failed
# diff as "no changes". pipefail would also count the SIGPIPE.
{
  git -c core.quotepath=off diff --no-color --find-renames "$base" --
  status=$?
  [ "$status" -eq 0 ] || [ "$status" -eq 141 ] || echo diff > "$failed"
  git ls-files -z --others --exclude-standard | head -z -n 200 | while IFS= read -r -d '' file; do
    git -c core.quotepath=off diff --no-color --no-index -- /dev/null "$file" || true
  done
  status=\${PIPESTATUS[0]}
  [ "$status" -eq 0 ] || [ "$status" -eq 141 ] || echo untracked > "$failed"
} | head -c ${WORKSPACE_DIFF_BYTE_LIMIT + 1} > "$out"
[ -s "$failed" ] && exit 5
if [ "$(wc -c < "$out")" -gt ${WORKSPACE_DIFF_BYTE_LIMIT} ]; then
  head -c ${WORKSPACE_DIFF_BYTE_LIMIT} "$out"
  printf '\\n%s\\n' ${WORKSPACE_DIFF_TRUNCATED_MARKER}
else
  cat "$out"
fi`;
}

function withRunningCheckout<A>(
	machines: WorkspaceMachines,
	scope: ExplorerScope,
	run: (
		workspaceId: WorkspaceId,
		root: string | null,
		roots: ProjectFileRoot[],
	) => Effect.Effect<A>,
): Effect.Effect<A | null> {
	return findCheckout(machines, scope).pipe(
		Effect.flatMap((checkout) =>
			checkout && checkout !== "none" && checkout.running
				? run(checkout.workspaceId, checkout.root, checkout.roots)
				: Effect.succeed(null),
		),
		Effect.catchAll(() => Effect.succeed(null)),
	);
}

type Checkout = {
	readonly workspaceId: WorkspaceId;
	readonly root: string | null;
	readonly roots: ProjectFileRoot[];
	/** False when the machine is paused, or when the caller did not ask. */
	readonly running: boolean;
	/** The chat's machine came from a recent lookup, not the database. */
	readonly reused: boolean;
};

type ChatMachine = {
	readonly workspaceId: WorkspaceId;
	readonly project: NonNullable<Awaited<ReturnType<typeof projectForOwner>>>;
};

/**
 * Files' recent chat-to-machine lookups in this isolate, so switching files
 * reads the file and not the database. Waking forgets the chat (it may get
 * another machine), and a read that fails on a remembered machine looks the
 * chat up again.
 */
const recentChatMachines = new Map<
	string,
	{ at: number; value: ChatMachine }
>();
const CHAT_MACHINE_REUSE_MS = 60_000;

function chatMachineKey(scope: ExplorerScope) {
	return `${scope.userId}\n${scope.projectId?.trim()}\n${scope.sessionId ?? ""}`;
}

export function forgetChatMachine(scope: ExplorerScope) {
	recentChatMachines.delete(chatMachineKey(scope));
}

async function lookUpChatMachine(
	scope: ExplorerScope,
	projectId: string,
	reuse: boolean,
): Promise<{ value: ChatMachine | "none" | null; reused: boolean }> {
	const key = chatMachineKey(scope);
	const recent = recentChatMachines.get(key);
	if (reuse && recent && Date.now() - recent.at < CHAT_MACHINE_REUSE_MS)
		return { value: recent.value, reused: true };
	const [peeked, project] = await Promise.all([
		peekAgentSessionMachine({
			userId: scope.userId,
			projectId,
			sessionId: scope.sessionId,
		}),
		projectForOwner(scope.userId, projectId),
	]);
	if (!peeked.providerRef) return { value: "none", reused: false };
	if (!project) return { value: null, reused: false };
	const value = { workspaceId: WorkspaceId(peeked.providerRef), project };
	if (recentChatMachines.size >= 1000) recentChatMachines.clear();
	recentChatMachines.set(key, { at: Date.now(), value });
	return { value, reused: false };
}

/**
 * The chat's machine and where its repositories are checked out; "none" when
 * the chat has no machine yet. The chat and project rows are read together
 * (or reused from a recent lookup, for Files), then the machine's state and
 * checkout directory together; the directory is remembered per machine,
 * since it never moves. Nothing is started.
 */
function findCheckout(
	machines: WorkspaceMachines,
	scope: ExplorerScope,
	options: { readonly askRunning?: boolean; readonly reuse?: boolean } = {},
): Effect.Effect<Checkout | "none" | null, unknown> {
	const projectId = scope.projectId?.trim();
	if (!projectId) return Effect.succeed(null);
	return Effect.tryPromise(async () => {
		const chat = await lookUpChatMachine(
			scope,
			projectId,
			options.reuse === true,
		);
		if (!chat.value || chat.value === "none") return chat.value;
		const { workspaceId, project } = chat.value;
		const [running, root] = await Promise.all([
			options.askRunning === false ? false : machines.isRunning(workspaceId),
			checkoutRoot(machines, workspaceId, project),
		]);
		const roots = root
			? repositoriesForProject(project).map((repo, index) => ({
					name: projectFolderName(repo.fullName),
					directory:
						index === 0
							? root
							: posix.join(
									posix.dirname(root),
									projectFolderName(repo.fullName),
								),
				}))
			: [];
		return { workspaceId, root, roots, running, reused: chat.reused };
	});
}

const checkoutRoots = new Map<string, string>();

/**
 * Where the chat's first repository is checked out: the path its checkout
 * recorded in /tmp, or, once a cold restart has cleared /tmp, the default
 * checkout path if a repository is there.
 */
async function checkoutRoot(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	project: ChatMachine["project"],
): Promise<string | null> {
	const known = checkoutRoots.get(workspaceId);
	if (known) return known;
	const cwd = await machines
		.readTextFile(workspaceId, PROJECT_CWD_PATH)
		.catch(() => null);
	let root = cwd?.trim() || null;
	const first = repositoriesForProject(project)[0];
	if (!root && first) {
		const fallback = projectCheckoutPath(
			"/home/ubuntu",
			projectFolderName(first.fullName),
		);
		const head = await machines
			.readTextFile(workspaceId, `${fallback}/.git/HEAD`)
			.catch(() => null);
		if (head) root = fallback;
	}
	if (root) {
		if (checkoutRoots.size >= 1000) checkoutRoots.clear();
		checkoutRoots.set(workspaceId, root);
	}
	return root;
}

function emptyListing(): WorkspaceExplorerListing {
	return { root: null, paths: [] };
}
