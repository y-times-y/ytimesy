import { Effect } from "effect";
import { WorkspaceId } from "#/domain/ids";
import { workspaceSessionMachineRef } from "#/domain/project-workspace";
import {
	desktopHostname,
	desktopPortIsListening,
	desktopViewerUrlForMachine,
	type WorkspaceDesktop,
} from "#/domain/workspace-desktop";
import {
	PROBE_WORKSPACE_DESKTOP,
	START_WORKSPACE_DESKTOP,
} from "#/server/adapters/freestyle/start-desktop";
import { readyWorkspaceForOwner } from "#/server/adapters/workspaces";
import type { WorkspaceMachines } from "./workspace-machines";

export type DesktopScope = {
	readonly userId: string;
	readonly projectId?: string;
};

export function readWorkspaceDesktop(
	machines: WorkspaceMachines,
	scope: DesktopScope,
): Effect.Effect<WorkspaceDesktop> {
	return Effect.gen(function* () {
		const key = scopeKey(scope);
		const cached = desktopFor(key);
		if (cached.status === "running" && cached.viewerUrl) return cached;
		const recovered = yield* recoverRunningDesktop(machines, scope);
		if (recovered) {
			desktops.set(key, recovered);
			return recovered;
		}
		return cached;
	});
}

export function startWorkspaceDesktop(
	machines: WorkspaceMachines,
	scope: DesktopScope,
): Effect.Effect<WorkspaceDesktop> {
	return Effect.gen(function* () {
		const workspace = yield* Effect.tryPromise(() =>
			readyWorkspaceForOwner(scope.userId, scope.projectId),
		);
		const providerRef = workspaceSessionMachineRef(workspace);
		if (!providerRef) {
			return {
				status: "failed" as const,
				reason: "Prepare a workspace before opening the desktop.",
			};
		}
		const key = scopeKey(scope);
		desktops.set(key, { status: "starting" });
		yield* Effect.tryPromise(() =>
			machines.ensureRunning(WorkspaceId(providerRef)),
		);
		const started = yield* Effect.tryPromise(() =>
			machines.exec(WorkspaceId(providerRef), START_WORKSPACE_DESKTOP, 240_000),
		);
		if (started.exitCode !== 0) {
			const failed: WorkspaceDesktop = {
				status: "failed",
				reason:
					(started.stderr || started.stdout).trim() ||
					"Desktop failed to start.",
			};
			desktops.set(key, failed);
			return failed;
		}
		const exposed = yield* Effect.either(
			Effect.tryPromise(() =>
				machines.exposeHttp(
					WorkspaceId(providerRef),
					6080,
					desktopHostname(providerRef),
				),
			),
		);
		const running: WorkspaceDesktop =
			exposed._tag === "Right"
				? {
						status: "running",
						viewerUrl: `${exposed.right}/vnc.html?autoconnect=1&resize=scale&reconnect=1`,
						display: ":0",
						message: "You and the agent share this desktop.",
					}
				: {
						status: "running",
						viewerUrl: desktopViewerUrlForMachine(providerRef),
						display: ":0",
						message:
							exposed.left instanceof Error
								? `Desktop is on display :0. Browser mapping reused the existing host: ${exposed.left.message}`
								: "Desktop is on display :0. Browser mapping reused the existing host.",
					};
		desktops.set(key, running);
		return running;
	}).pipe(
		Effect.catchAll((cause) => {
			const failed: WorkspaceDesktop = {
				status: "failed",
				reason: cause instanceof Error ? cause.message : String(cause),
			};
			desktops.set(scopeKey(scope), failed);
			return Effect.succeed(failed);
		}),
	);
}

function recoverRunningDesktop(
	machines: WorkspaceMachines,
	scope: DesktopScope,
): Effect.Effect<WorkspaceDesktop | null> {
	return Effect.gen(function* () {
		const workspace = yield* Effect.tryPromise(() =>
			readyWorkspaceForOwner(scope.userId, scope.projectId),
		);
		const providerRef = workspaceSessionMachineRef(workspace);
		if (!providerRef) return null;
		yield* Effect.tryPromise(() =>
			machines.ensureRunning(WorkspaceId(providerRef)),
		);
		const probe = yield* Effect.tryPromise(() =>
			machines.exec(WorkspaceId(providerRef), PROBE_WORKSPACE_DESKTOP, 15_000),
		);
		if (!desktopPortIsListening(`${probe.stdout}\n${probe.stderr}`))
			return null;
		return {
			status: "running" as const,
			viewerUrl: desktopViewerUrlForMachine(providerRef),
			display: ":0" as const,
			message: "You and the agent share this desktop.",
		};
	}).pipe(Effect.catchAll(() => Effect.succeed(null)));
}

const desktops = new Map<string, WorkspaceDesktop>();

function scopeKey(scope: DesktopScope) {
	return `${scope.userId}:${scope.projectId ?? ""}`;
}

function desktopFor(key: string): WorkspaceDesktop {
	return desktops.get(key) ?? { status: "stopped" };
}
