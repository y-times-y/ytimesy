import { Effect } from "effect";
import { WorkspaceId } from "#/domain/ids";
import type { WorkspaceDesktop } from "#/domain/workspace-desktop";
import { START_WORKSPACE_DESKTOP } from "#/server/adapters/freestyle/start-desktop";
import { readProofVmState } from "#/server/proof/codex-login-state";
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
				reason: "Start a harness workspace before opening the desktop.",
			};
		}
		currentDesktop = { status: "starting" };
		const started = yield* Effect.tryPromise(() =>
			machines.exec(WorkspaceId(vm.workspaceId), START_WORKSPACE_DESKTOP, 240_000),
		);
		if (started.exitCode !== 0) {
			currentDesktop = {
				status: "failed",
				reason: (started.stderr || started.stdout).trim() || "Desktop failed to start.",
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
				viewerUrl: `${origin}/vnc.html?autoconnect=1&resize=scale&reconnect=1`,
				display: ":0",
				message: "You and the agent share this desktop.",
			};
		} catch (cause) {
			currentDesktop = {
				status: "running",
				viewerUrl: null,
				display: ":0",
				message:
					cause instanceof Error
						? `Desktop is on display :0 but not reachable from the browser: ${cause.message}`
						: "Desktop is on display :0 but not reachable from the browser.",
			};
		}
		return currentDesktop;
	}).pipe(
		Effect.catchAll((cause) => {
			currentDesktop = {
				status: "failed",
				reason: cause instanceof Error ? cause.message : String(cause),
			};
			return Effect.succeed(currentDesktop);
		}),
	);
}

let currentDesktop: WorkspaceDesktop = { status: "stopped" };

function desktopHostname(workspaceId: string): string {
	const slug = workspaceId.replaceAll(/[^a-zA-Z0-9]/g, "").slice(-12).toLowerCase();
	return `ytimesy-desk-${slug || "local"}.style.dev`;
}
