import { Effect } from "effect";
import { WorkspaceId } from "#/domain/ids";
import { workspaceSessionMachineRef } from "#/domain/project-workspace";
import type { WorkspaceDesktop } from "#/domain/workspace-desktop";
import { START_WORKSPACE_DESKTOP } from "#/server/adapters/freestyle/start-desktop";
import { readyWorkspaceForOwner } from "#/server/adapters/workspaces";
import type { WorkspaceMachines } from "./workspace-machines";

export type DesktopScope = {
	readonly userId: string;
	readonly projectId?: string;
};

export function readWorkspaceDesktop(
	_machines: WorkspaceMachines,
	scope: DesktopScope,
): Effect.Effect<WorkspaceDesktop> {
	return Effect.succeed(desktopFor(scopeKey(scope)));
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
		const hostname = desktopHostname(providerRef);
		try {
			const origin = yield* Effect.tryPromise(() =>
				machines.exposeHttp(WorkspaceId(providerRef), 6080, hostname),
			);
			const running: WorkspaceDesktop = {
				status: "running",
				viewerUrl: `${origin}/vnc.html?autoconnect=1&resize=scale&reconnect=1`,
				display: ":0",
				message: "You and the agent share this desktop.",
			};
			desktops.set(key, running);
			return running;
		} catch (cause) {
			const running: WorkspaceDesktop = {
				status: "running",
				viewerUrl: null,
				display: ":0",
				message:
					cause instanceof Error
						? `Desktop is on display :0 but not reachable from the browser: ${cause.message}`
						: "Desktop is on display :0 but not reachable from the browser.",
			};
			desktops.set(key, running);
			return running;
		}
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

const desktops = new Map<string, WorkspaceDesktop>();

function scopeKey(scope: DesktopScope) {
	return `${scope.userId}:${scope.projectId ?? ""}`;
}

function desktopFor(key: string): WorkspaceDesktop {
	return desktops.get(key) ?? { status: "stopped" };
}

function desktopHostname(workspaceId: string): string {
	const slug = workspaceId
		.replaceAll(/[^a-zA-Z0-9]/g, "")
		.slice(-12)
		.toLowerCase();
	return `ytimesy-desk-${slug || "local"}.style.dev`;
}
