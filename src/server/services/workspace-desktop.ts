import { Effect } from "effect";
import { copiedAgentMachineRef } from "#/domain/agent-session";
import { WorkspaceId } from "#/domain/ids";
import { workspaceSessionMachineRef } from "#/domain/project-workspace";
import {
	desktopEmbedUrl,
	desktopHostname,
	desktopPortIsListening,
	desktopStartFailureReason,
	desktopViewerUrlForMachine,
	START_HARNESS_BEFORE_DESKTOP,
	type WorkspaceDesktop,
} from "#/domain/workspace-desktop";
import {
	DESKTOP_WALLPAPER_B64_PATH,
	desktopWallpaperBase64,
} from "#/server/adapters/freestyle/desktop-wallpaper";
import {
	PROBE_WORKSPACE_DESKTOP,
	START_WORKSPACE_DESKTOP,
} from "#/server/adapters/freestyle/start-desktop";
import { readyWorkspaceForOwner } from "#/server/adapters/workspaces";
import {
	bindAgentSessionMachine,
	peekAgentSessionMachine,
} from "./agent-session-machine";
import type { WorkspaceMachines } from "./workspace-machines";

export type DesktopScope = {
	readonly userId: string;
	readonly projectId?: string;
	readonly sessionId?: string;
};

/**
 * Recovers a running desktop on the prepared project VM, or returns the
 * last in-memory status for this owner and project.
 */
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

/**
 * Writes the ytimesy wallpaper, starts the shared X desktop, and maps noVNC.
 * Chrome install on a cold VM can take several minutes.
 */
export function startWorkspaceDesktop(
	machines: WorkspaceMachines,
	scope: DesktopScope,
): Effect.Effect<WorkspaceDesktop> {
	return Effect.gen(function* () {
		const workspace = yield* Effect.tryPromise(() =>
			readyWorkspaceForOwner(scope.userId, scope.projectId),
		);
		if (
			!workspace ||
			!workspaceSessionMachineRef(workspace) ||
			!scope.projectId
		) {
			return {
				status: "failed" as const,
				reason: START_HARNESS_BEFORE_DESKTOP,
			};
		}
		const peeked = yield* Effect.tryPromise(() =>
			peekAgentSessionMachine({
				userId: scope.userId,
				projectId: scope.projectId as string,
				sessionId: scope.sessionId,
			}),
		);
		const existing = peeked.session;
		if (!existing) {
			return {
				status: "failed" as const,
				reason: START_HARNESS_BEFORE_DESKTOP,
			};
		}
		let providerRef = copiedAgentMachineRef({
			sessionProviderRef: peeked.providerRef,
			templateProviderRef: workspace.providerRef,
		});
		if (!providerRef && !peeked.providerRef) {
			const bound = yield* Effect.tryPromise(() =>
				bindAgentSessionMachine(machines, {
					userId: scope.userId,
					projectId: scope.projectId as string,
					harness: existing.harness,
					sessionId: existing.id,
				}),
			);
			providerRef = copiedAgentMachineRef({
				sessionProviderRef: bound.providerRef,
				templateProviderRef: workspace.providerRef,
			});
		}
		if (!providerRef) {
			return {
				status: "failed" as const,
				reason: START_HARNESS_BEFORE_DESKTOP,
			};
		}
		const key = scopeKey(scope);
		desktops.set(key, { status: "starting" });
		yield* Effect.tryPromise(() =>
			machines.ensureRunning(WorkspaceId(providerRef)),
		);
		yield* Effect.tryPromise(() =>
			machines.writeTextFile(
				WorkspaceId(providerRef),
				DESKTOP_WALLPAPER_B64_PATH,
				desktopWallpaperBase64(),
			),
		);
		const started = yield* Effect.tryPromise(() =>
			machines.exec(WorkspaceId(providerRef), START_WORKSPACE_DESKTOP, 300_000),
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
						viewerUrl: desktopEmbedUrl(exposed.right),
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
				reason: desktopStartFailureReason(cause),
			};
			desktops.set(scopeKey(scope), failed);
			return Effect.succeed(failed);
		}),
	);
}

/**
 * Probe a guest that is already running. Do not start a paused VM just to
 * learn that Desktop is stopped — that burns vCPU-hours on chat switch.
 */
export async function desktopFromRunningGuest(
	machines: Pick<WorkspaceMachines, "isRunning" | "exec">,
	providerRef: string,
): Promise<WorkspaceDesktop | null> {
	const running = await machines.isRunning(WorkspaceId(providerRef));
	if (!running) return null;
	const probe = await machines.exec(
		WorkspaceId(providerRef),
		PROBE_WORKSPACE_DESKTOP,
		15_000,
	);
	if (!desktopPortIsListening(`${probe.stdout}\n${probe.stderr}`)) return null;
	return {
		status: "running",
		viewerUrl: desktopViewerUrlForMachine(providerRef),
		display: ":0",
		message: "You and the agent share this desktop.",
	};
}

function recoverRunningDesktop(
	machines: WorkspaceMachines,
	scope: DesktopScope,
): Effect.Effect<WorkspaceDesktop | null> {
	return Effect.gen(function* () {
		if (!scope.projectId) return null;
		const workspace = yield* Effect.tryPromise(() =>
			readyWorkspaceForOwner(scope.userId, scope.projectId),
		);
		const peeked = yield* Effect.tryPromise(() =>
			peekAgentSessionMachine({
				userId: scope.userId,
				projectId: scope.projectId as string,
				sessionId: scope.sessionId,
			}),
		);
		const providerRef = copiedAgentMachineRef({
			sessionProviderRef: peeked.providerRef,
			templateProviderRef: workspace?.providerRef ?? null,
		});
		if (!providerRef) return null;
		return yield* Effect.tryPromise(() =>
			desktopFromRunningGuest(machines, providerRef),
		);
	}).pipe(Effect.catchAll(() => Effect.succeed(null)));
}

const desktops = new Map<string, WorkspaceDesktop>();

function scopeKey(scope: DesktopScope) {
	return `${scope.userId}:${scope.projectId ?? ""}:${scope.sessionId ?? ""}`;
}

function desktopFor(key: string): WorkspaceDesktop {
	return desktops.get(key) ?? { status: "stopped" };
}
