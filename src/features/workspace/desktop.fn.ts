import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";
import type { WorkspaceDesktop } from "#/domain/workspace-desktop";
import { FreestyleWorkspaceMachinesLive } from "#/server/adapters/freestyle/live";
import { WorkspaceMachineService } from "#/server/services/capabilities";
import {
	readWorkspaceDesktop,
	startWorkspaceDesktop,
} from "#/server/services/workspace-desktop";
import type { WorkspaceMachines } from "#/server/services/workspace-machines";

function runWithMachines<A>(
	run: (machines: WorkspaceMachines) => Effect.Effect<A>,
): Promise<A> {
	return Effect.runPromise(
		Effect.gen(function* () {
			const machines = yield* WorkspaceMachineService;
			return yield* run(machines);
		}).pipe(Effect.provide(FreestyleWorkspaceMachinesLive)),
	);
}

export const getWorkspaceDesktop = createServerFn({ method: "GET" }).handler(
	async (): Promise<WorkspaceDesktop> => {
		return runWithMachines(readWorkspaceDesktop).catch(() => ({
			status: "stopped" as const,
		}));
	},
);

export const startWorkspaceDesktopFn = createServerFn({
	method: "POST",
}).handler(async (): Promise<WorkspaceDesktop> => {
	return runWithMachines(startWorkspaceDesktop);
});
