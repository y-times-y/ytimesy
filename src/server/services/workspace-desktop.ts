import { Effect } from "effect";
import { WorkspaceId } from "#/domain/ids";
import {
	desktopEmbedUrl,
	desktopFailedBecauseWorkspaceGone,
	desktopStartFailureReason,
	START_HARNESS_BEFORE_DESKTOP,
	type WorkspaceDesktop,
} from "#/domain/workspace-desktop";
import {
	DESKTOP_WALLPAPER_B64_PATH,
	desktopWallpaperBase64,
} from "#/server/adapters/freestyle/desktop-wallpaper";
import { START_WORKSPACE_DESKTOP } from "#/server/adapters/freestyle/start-desktop";
import {
	deleteProofVmState,
	readProofVmState,
} from "#/server/proof/codex-login-state";
import type { WorkspaceMachines } from "./workspace-machines";

export function readWorkspaceDesktop(
	_machines: WorkspaceMachines,
): Effect.Effect<WorkspaceDesktop> {
	return Effect.succeed(currentDesktop);
}

export function startWorkspaceDesktop(
	machines: WorkspaceMachines,
): Effect.Effect<WorkspaceDesktop> {
	return Effect.gen(function* () {
		const vm = yield* Effect.tryPromise(() => readProofVmState());
		if (!vm) {
			return {
				status: "failed" as const,
				reason: START_HARNESS_BEFORE_DESKTOP,
			};
		}
		currentDesktop = { status: "starting" };
		yield* Effect.tryPromise(() =>
			machines.writeTextFile(
				WorkspaceId(vm.workspaceId),
				DESKTOP_WALLPAPER_B64_PATH,
				desktopWallpaperBase64(),
			),
		);
		const started = yield* Effect.tryPromise(() =>
			machines.exec(
				WorkspaceId(vm.workspaceId),
				START_WORKSPACE_DESKTOP,
				300_000,
			),
		);
		if (started.exitCode !== 0) {
			currentDesktop = {
				status: "failed",
				reason:
					(started.stderr || started.stdout).trim() ||
					"Desktop failed to start.",
			};
			return currentDesktop;
		}
		const hostname = desktopHostname(vm.workspaceId);
		try {
			const origin = yield* Effect.tryPromise(() =>
				machines.exposeHttp(WorkspaceId(vm.workspaceId), 6080, hostname),
			);
			currentDesktop = {
				status: "running",
				viewerUrl: desktopEmbedUrl(origin),
				display: ":0",
				message: "You and the agent share this desktop.",
			};
		} catch (cause) {
			currentDesktop = {
				status: "running",
				viewerUrl: null,
				display: ":0",
				message: `Desktop is on display :0 but not reachable from the browser: ${desktopStartFailureReason(cause)}`,
			};
		}
		return currentDesktop;
	}).pipe(
		Effect.catchAll((cause) =>
			Effect.gen(function* () {
				if (desktopFailedBecauseWorkspaceGone(cause)) {
					yield* Effect.tryPromise(() => deleteProofVmState()).pipe(
						Effect.catchAll(() => Effect.void),
					);
				}
				currentDesktop = {
					status: "failed",
					reason: desktopStartFailureReason(cause),
				};
				return currentDesktop;
			}),
		),
	);
}

let currentDesktop: WorkspaceDesktop = { status: "stopped" };

function desktopHostname(workspaceId: string): string {
	const slug = workspaceId
		.replaceAll(/[^a-zA-Z0-9]/g, "")
		.slice(-12)
		.toLowerCase();
	return `ytimesy-desk-${slug || "local"}.style.dev`;
}
