import { posix } from "node:path";
import { Effect } from "effect";
import type { WorkspaceFilePreview } from "#/domain/file-preview";
import { parseGitDiffChanges } from "#/domain/git-diff";
import { WorkspaceId } from "#/domain/ids";
import { posixShellQuoted } from "#/domain/posix-command";
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

const LIST_WORKSPACE_FILES = `CWD=""
if [ -f ${PROJECT_CWD_PATH} ]; then
  CWD=$(tr -d '\\n' < ${PROJECT_CWD_PATH})
fi
if [ -z "$CWD" ] || [ ! -d "$CWD/.git" ]; then
  exit 0
fi
echo "PROJECT_CWD=$CWD"
git -C "$CWD" ls-files -co --exclude-standard
`;

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
 * Lists the checkout without starting a paused VM. Files falls back to
 * turn changes when the machine is asleep.
 */
export function listWorkspaceExplorer(
	machines: WorkspaceMachines,
	scope: ExplorerScope,
): Effect.Effect<WorkspaceExplorerListing> {
	return withRunningCheckout(machines, scope, (workspaceId, _root, roots) =>
		Effect.tryPromise(() =>
			machines.exec(
				workspaceId,
				`bash -lc ${posixShellQuoted(roots.length > 1 ? roots.map((root) => `git -C ${posixShellQuoted(root.directory)} ls-files -co --exclude-standard | while IFS= read -r file; do printf '%s/%s\\n' ${posixShellQuoted(root.name)} "$file"; done`).join("\n") : LIST_WORKSPACE_FILES)}`,
				20_000,
			),
		).pipe(
			Effect.map((result) => {
				const listing = parseWorkspaceExplorerListing(result.stdout);
				return roots.length > 1
					? { ...listing, root: posix.dirname(roots[0].directory) }
					: listing;
			}),
			Effect.catchAll(() => Effect.succeed(emptyListing())),
		),
	).pipe(
		Effect.flatMap((listing) =>
			listing
				? Effect.succeed(listing)
				: idleMachine(machines, scope).pipe(
						Effect.map((machine) => ({ ...emptyListing(), machine })),
					),
		),
	);
}

/** Why the checkout can't be read: this chat has no machine yet, or it is asleep. */
function idleMachine(
	machines: WorkspaceMachines,
	scope: ExplorerScope,
): Effect.Effect<"none" | "asleep" | undefined> {
	const projectId = scope.projectId?.trim();
	if (!projectId) return Effect.succeed(undefined);
	return Effect.gen(function* () {
		const peeked = yield* Effect.tryPromise(() =>
			peekAgentSessionMachine({
				userId: scope.userId,
				projectId,
				sessionId: scope.sessionId,
			}),
		);
		if (!peeked.providerRef) return "none" as const;
		const running = yield* Effect.tryPromise(() =>
			machines.isRunning(WorkspaceId(peeked.providerRef as string)),
		);
		return running ? undefined : ("asleep" as const);
	}).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
}

export function readWorkspaceExplorerFile(
	machines: WorkspaceMachines,
	scope: ExplorerScope,
	requested: string,
): Effect.Effect<WorkspaceSourceFile | null> {
	const want = requested.trim();
	if (!want) return Effect.succeed(null);
	return withRunningCheckout(machines, scope, (workspaceId, _root, roots) => {
		const path = resolveProjectFile(roots, want)?.path;
		if (!path) return Effect.succeed(null);
		return Effect.tryPromise(() =>
			machines.readTextFile(workspaceId, path),
		).pipe(
			Effect.map((contents) => {
				const text = workspaceSourceText(contents);
				return text == null ? null : { path: want, text };
			}),
			Effect.catchAll(() => Effect.succeed(null)),
		);
	}).pipe(Effect.map((file) => file ?? null));
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
					...parseGitDiffChanges(
						result.stdout,
						roots.length > 1 ? `${root.name}/` : "",
					),
				);
			}
			return changes;
		}).pipe(Effect.catchAll(() => Effect.succeed(null))),
	);
}

/** Diff against the merge base with the chat's base branch, plus untracked files. */
function gitChangesScript(directory: string, base: string) {
	return `set -o pipefail
cd ${posixShellQuoted(directory)} || exit 3
base=""
for ref in ${base ? `${posixShellQuoted(`origin/${base}`)} ${posixShellQuoted(base)} ` : ""}'@{upstream}' origin/HEAD; do
  base=$(git merge-base HEAD "$ref" 2>/dev/null) && break
done
[ -n "$base" ] || base=HEAD
{
  git -c core.quotepath=off diff --no-color --find-renames "$base" --
  git ls-files -z --others --exclude-standard | head -z -n 200 | while IFS= read -r -d '' file; do
    git -c core.quotepath=off diff --no-color --no-index -- /dev/null "$file" || true
  done
} | head -c 4000000`;
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
	const projectId = scope.projectId?.trim();
	if (!projectId) return Effect.succeed(null);
	return Effect.gen(function* () {
		const peeked = yield* Effect.tryPromise(() =>
			peekAgentSessionMachine({
				userId: scope.userId,
				projectId,
				sessionId: scope.sessionId,
			}),
		);
		const providerRef = peeked.providerRef;
		if (!providerRef) return null;
		const workspaceId = WorkspaceId(providerRef);
		const running = yield* Effect.tryPromise(() =>
			machines.isRunning(workspaceId),
		);
		if (!running) return null;
		const cwd = yield* Effect.tryPromise(() =>
			machines.readTextFile(workspaceId, PROJECT_CWD_PATH),
		).pipe(Effect.catchAll(() => Effect.succeed(null)));
		const root = cwd?.trim() || null;
		const project = yield* Effect.tryPromise(() =>
			projectForOwner(scope.userId, projectId),
		);
		if (!project) return null;
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
		return yield* run(workspaceId, root, roots);
	}).pipe(Effect.catchAll(() => Effect.succeed(null)));
}

function emptyListing(): WorkspaceExplorerListing {
	return { root: null, paths: [] };
}
