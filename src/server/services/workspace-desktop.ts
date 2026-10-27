import { Effect } from "effect";
import { copiedAgentMachineRef } from "#/domain/agent-session";
import { failureMessage } from "#/domain/failure-message";
import { WorkspaceId } from "#/domain/ids";
import { workspaceEnvironmentIsReady } from "#/domain/project-workspace";
import {
	desktopClientViewerUrl,
	desktopPortIsListening,
	desktopRemoteOrigin,
	desktopStartFailureReason,
	START_HARNESS_BEFORE_DESKTOP,
	type WorkspaceDesktop,
} from "#/domain/workspace-desktop";
import {
	DESKTOP_WALLPAPER_B64_PATH,
	desktopWallpaperBase64,
} from "#/server/adapters/freestyle/desktop-wallpaper";
import {
	DESKTOP_CREDENTIAL_DROP_SETUP,
	DESKTOP_PRIVATE_READY,
	DESKTOP_VIEWER_CREDENTIAL_PATH,
	DESKTOP_VNC_PASSWORD_PATH,
	ENSURE_WORKSPACE_DESKTOP,
	probeWorkspaceDesktop,
	START_WORKSPACE_DESKTOP,
} from "#/server/adapters/freestyle/start-desktop";
import { readyWorkspaceForOwner } from "#/server/adapters/workspaces";
import {
	bindAgentSessionMachine,
	peekAgentSessionMachine,
} from "./agent-session-machine";
import {
	desktopEdgeHostname,
	desktopViewerAuthorization,
	desktopViewerCredential,
	desktopViewerCredentialDigest,
	desktopVncPassword,
} from "./vm-edge-keys";
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
		const cached = clientFacingDesktop(desktopFor(key), scope);
		if (cached.status === "running" && cached.viewerUrl) return cached;
		const recovered = yield* recoverRunningDesktop(machines, scope);
		if (recovered) {
			desktops.set(key, recovered);
			return clientFacingDesktop(recovered, scope);
		}
		return cached;
	});
}

/**
 * Writes the ytimesy wallpaper, starts the shared X desktop, and maps the
 * display through a same-origin viewer. Chrome install continues in the
 * background so Connect is not blocked.
 */
/**
 * Makes sure this chat has its own machine and that it is running: a new or
 * forked chat gets a copy of the project's machine on first use (a minute or
 * two), and an asleep one is started. Null when the project isn't ready yet.
 */
export function ensureSessionMachine(
	machines: WorkspaceMachines,
	scope: DesktopScope,
): Effect.Effect<string | null, unknown> {
	return Effect.gen(function* () {
		if (!scope.projectId) return null;
		const projectId = scope.projectId;
		const [workspace, peeked] = yield* Effect.tryPromise(() =>
			Promise.all([
				readyWorkspaceForOwner(scope.userId, projectId),
				peekAgentSessionMachine({
					userId: scope.userId,
					projectId,
					sessionId: scope.sessionId,
				}),
			]),
		);
		if (!workspace || !workspaceEnvironmentIsReady(workspace)) return null;
		const existing = peeked.session;
		if (!existing) return null;
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
		if (!providerRef) return null;
		const ref = providerRef;
		yield* Effect.tryPromise(() => machines.ensureRunning(WorkspaceId(ref)));
		return ref;
	});
}

/**
 * Starts this chat's machine when it has one and it is asleep, so a terminal
 * or desktop opened next connects without that wait. Never creates one.
 */
export function resumeSessionMachine(
	machines: Pick<WorkspaceMachines, "ensureRunning">,
	scope: DesktopScope,
): Effect.Effect<boolean, unknown> {
	return Effect.gen(function* () {
		const ref = yield* Effect.tryPromise(() => peekSessionMachineRef(scope));
		if (!ref) return false;
		yield* Effect.tryPromise(() => machines.ensureRunning(WorkspaceId(ref)));
		return true;
	});
}

export function startWorkspaceDesktop(
	machines: WorkspaceMachines,
	scope: DesktopScope,
): Effect.Effect<WorkspaceDesktop> {
	return Effect.gen(function* () {
		const key = scopeKey(scope);
		const providerRef = yield* ensureSessionMachine(machines, scope);
		if (!providerRef || !scope.projectId) {
			return {
				status: "failed" as const,
				reason: START_HARNESS_BEFORE_DESKTOP,
			};
		}
		desktops.set(key, { status: "starting" });
		const started = yield* Effect.tryPromise(() =>
			ensureDesktopProcesses(machines, providerRef),
		);
		if (started.exitCode !== 0) {
			const failed: WorkspaceDesktop = {
				status: "failed",
				reason: desktopStartFailureReason(
					new Error(
						(started.stderr || started.stdout).trim() ||
							"Desktop failed to start.",
					),
				),
			};
			desktops.set(key, failed);
			return failed;
		}
		yield* Effect.either(
			Effect.tryPromise(() => publishDesktopViewer(machines, providerRef)),
		);
		remotes.set(key, providerRef);
		const running = clientFacingDesktop(
			{
				status: "running",
				viewerUrl: desktopClientViewerUrl({
					projectId: scope.projectId as string,
					sessionId: scope.sessionId,
				}),
				display: ":0",
				message: "You and the agent share this desktop.",
			},
			scope,
		);
		desktops.set(key, running);
		return running;
	}).pipe(
		Effect.catchAll((cause) => {
			console.error("desktop start failed", failureMessage(cause));
			const failed: WorkspaceDesktop = {
				status: "failed",
				reason: desktopStartFailureReason(cause),
			};
			desktops.set(scopeKey(scope), failed);
			return Effect.succeed(failed);
		}),
	);
}

export async function ensureDesktopProcesses(
	machines: Pick<WorkspaceMachines, "exec" | "writeTextFile">,
	providerRef: string,
) {
	const id = WorkspaceId(providerRef);
	const probe = await machines.exec(
		id,
		probeWorkspaceDesktop(desktopViewerCredentialDigest(providerRef)),
		15_000,
	);
	if (probe.exitCode === 0 && desktopPortIsListening(probe.stdout))
		return probe;
	await machines.writeTextFile(
		id,
		DESKTOP_WALLPAPER_B64_PATH,
		desktopWallpaperBase64(),
	);
	// The credential goes only into the builder's verified 0700 directory;
	// one another user created or linked first is refused.
	const drop = await machines.exec(id, DESKTOP_CREDENTIAL_DROP_SETUP, 15_000);
	if (drop.exitCode !== 0 || !drop.stdout.includes(DESKTOP_PRIVATE_READY))
		throw new Error(
			`The desktop's private directory could not be secured: ${drop.stderr.slice(-300)}`,
		);
	await machines.writeTextFile(
		id,
		DESKTOP_VIEWER_CREDENTIAL_PATH,
		desktopViewerCredential(providerRef),
	);
	await machines.writeTextFile(
		id,
		DESKTOP_VNC_PASSWORD_PATH,
		desktopVncPassword(providerRef),
	);
	return machines.exec(id, START_WORKSPACE_DESKTOP, 300_000);
}

/** Publishes the VM's viewer port under its keyed name, replacing any older desktop route. */
export function publishDesktopViewer(
	machines: Pick<WorkspaceMachines, "exposeHttp">,
	providerRef: string,
) {
	return machines.exposeHttp(
		WorkspaceId(providerRef),
		6080,
		desktopEdgeHostname(providerRef),
	);
}

export async function withdrawDesktopViewer(
	machines: Pick<WorkspaceMachines, "withdrawHttpRoutes">,
	providerRef: string,
) {
	return (
		(await machines.withdrawHttpRoutes?.(WorkspaceId(providerRef), ["desk"])) ??
		0
	);
}

export type DesktopRemote = {
	readonly origin: string;
	/** websockify's BasicHTTPAuth header; only the server relay holds it. */
	readonly authorization: string;
};

function desktopRemoteFor(providerRef: string): DesktopRemote {
	return {
		origin: desktopRemoteOrigin(desktopEdgeHostname(providerRef)),
		authorization: desktopViewerAuthorization(providerRef),
	};
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
		probeWorkspaceDesktop(desktopViewerCredentialDigest(providerRef)),
		15_000,
	);
	if (!desktopPortIsListening(`${probe.stdout}\n${probe.stderr}`)) return null;
	return {
		status: "running",
		viewerUrl: null,
		display: ":0",
		message: "You and the agent share this desktop.",
	};
}

export async function resolveDesktopRemote(
	scope: DesktopScope,
): Promise<DesktopRemote | null> {
	const cached = remotes.get(scopeKey(scope));
	if (cached) return desktopRemoteFor(cached);
	const providerRef = await peekSessionMachineRef(scope);
	if (!providerRef) return null;
	remotes.set(scopeKey(scope), providerRef);
	return desktopRemoteFor(providerRef);
}

/** The owner's chat machine for this scope, without creating or starting it. */
export async function peekSessionMachineRef(scope: DesktopScope) {
	if (!scope.projectId) return null;
	const [workspace, peeked] = await Promise.all([
		readyWorkspaceForOwner(scope.userId, scope.projectId),
		peekAgentSessionMachine({
			userId: scope.userId,
			projectId: scope.projectId,
			sessionId: scope.sessionId,
		}),
	]);
	return copiedAgentMachineRef({
		sessionProviderRef: peeked.providerRef,
		templateProviderRef: workspace?.providerRef ?? null,
	});
}

function recoverRunningDesktop(
	machines: WorkspaceMachines,
	scope: DesktopScope,
): Effect.Effect<WorkspaceDesktop | null> {
	return Effect.gen(function* () {
		if (!scope.projectId) return null;
		const projectId = scope.projectId;
		const [workspace, peeked] = yield* Effect.tryPromise(() =>
			Promise.all([
				readyWorkspaceForOwner(scope.userId, projectId),
				peekAgentSessionMachine({
					userId: scope.userId,
					projectId,
					sessionId: scope.sessionId,
				}),
			]),
		);
		const providerRef = copiedAgentMachineRef({
			sessionProviderRef: peeked.providerRef,
			templateProviderRef: workspace?.providerRef ?? null,
		});
		if (!providerRef) return null;
		const recovered = yield* Effect.tryPromise(() =>
			desktopFromRunningGuest(machines, providerRef),
		);
		if (!recovered) {
			// Asleep or not serving: take the viewer route down until a start republishes it.
			remotes.delete(scopeKey(scope));
			yield* Effect.tryPromise(() =>
				withdrawDesktopViewer(machines, providerRef),
			).pipe(Effect.catchAll(() => Effect.void));
			return null;
		}
		remotes.set(scopeKey(scope), providerRef);
		void machines
			.exec(WorkspaceId(providerRef), ENSURE_WORKSPACE_DESKTOP, 120_000)
			.catch(() => undefined);
		void publishDesktopViewer(machines, providerRef).catch(() => undefined);
		return clientFacingDesktop(recovered, scope);
	}).pipe(Effect.catchAll(() => Effect.succeed(null)));
}

const desktops = new Map<string, WorkspaceDesktop>();
/** Scope → the VM whose desktop the relay connects to. */
const remotes = new Map<string, string>();

function scopeKey(scope: DesktopScope) {
	return `${scope.userId}:${scope.projectId ?? ""}:${scope.sessionId ?? ""}`;
}

function desktopFor(key: string): WorkspaceDesktop {
	return desktops.get(key) ?? { status: "stopped" };
}

function clientFacingDesktop(
	desktop: WorkspaceDesktop,
	scope: DesktopScope,
): WorkspaceDesktop {
	if (desktop.status !== "running") return desktop;
	const providerRef = remotes.get(scopeKey(scope));
	return {
		...desktop,
		// Only the owner's viewer gets the VNC password (this scope is theirs).
		...(providerRef ? { viewerPassword: desktopVncPassword(providerRef) } : {}),
		viewerUrl: scope.projectId
			? desktopClientViewerUrl({
					projectId: scope.projectId,
					sessionId: scope.sessionId,
				})
			: null,
		message: "You and the agent share this desktop.",
	};
}
