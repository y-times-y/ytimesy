import { Effect } from "effect";
import { WorkspaceId } from "#/domain/ids";
import type { WorkspaceFilePreview } from "#/domain/file-preview";
import { filePreviewCommand } from "./file-preview-command";
import { posixShellQuoted } from "#/domain/posix-command";
import {
	parseWorkspaceExplorerListing,
	type WorkspaceExplorerListing,
	type WorkspaceSourceFile,
	type WorkspaceSourceWrite,
	workspaceSourcePath,
	workspaceSourceText,
	workspaceSourceWriteText,
} from "#/domain/workspace-explorer";
import { PROJECT_CWD_PATH } from "#/server/adapters/freestyle/clone-project";
import { peekAgentSessionMachine } from "./agent-session-machine";
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

/**
 * Lists the checkout without starting a paused VM. Files falls back to
 * turn changes when the machine is asleep.
 */
export function listWorkspaceExplorer(
	machines: WorkspaceMachines,
	scope: ExplorerScope,
): Effect.Effect<WorkspaceExplorerListing> {
	return withRunningCheckout(machines, scope, (workspaceId) =>
		Effect.tryPromise(() =>
			machines.exec(
				workspaceId,
				`bash -lc ${posixShellQuoted(LIST_WORKSPACE_FILES)}`,
				20_000,
			),
		).pipe(
			Effect.map((result) => parseWorkspaceExplorerListing(result.stdout)),
			Effect.catchAll(() => Effect.succeed(emptyListing())),
		),
	).pipe(Effect.map((listing) => listing ?? emptyListing()));
}

export function readWorkspaceExplorerFile(
	machines: WorkspaceMachines,
	scope: ExplorerScope,
	requested: string,
): Effect.Effect<WorkspaceSourceFile | null> {
	const want = requested.trim();
	if (!want) return Effect.succeed(null);
	return withRunningCheckout(machines, scope, (workspaceId, root) => {
		const path = root ? workspaceSourcePath(root, want) : null;
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
	return withRunningCheckout(machines, scope, (workspaceId, root) => {
		const path = root ? workspaceSourcePath(root, want) : null;
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
	return withRunningCheckout(machines, scope, (id, root) => {
		if (!root)
			return Effect.succeed<WorkspaceFilePreview>({
				kind: "unavailable",
				reason: "Checkout is unavailable.",
			});
		return Effect.tryPromise(async (): Promise<WorkspaceFilePreview> => {
			const output = await machines.exec(
				id,
				filePreviewCommand(root, path, revision),
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

function withRunningCheckout<A>(
	machines: WorkspaceMachines,
	scope: ExplorerScope,
	run: (workspaceId: WorkspaceId, root: string | null) => Effect.Effect<A>,
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
		return yield* run(workspaceId, cwd?.trim() || null);
	}).pipe(Effect.catchAll(() => Effect.succeed(null)));
}

function emptyListing(): WorkspaceExplorerListing {
	return { root: null, paths: [] };
}
