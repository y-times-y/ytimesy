import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { Effect } from "effect";
import { publicFailureMessage } from "#/domain/project-workspace";
import { FreestyleWorkspaceMachinesLive } from "#/server/adapters/freestyle/live";
import { requireUser } from "#/server/auth/auth";
import { WorkspaceMachineService } from "#/server/services/capabilities";
import { removeProjectMachine } from "#/server/services/projects";
import type { WorkspaceMachines } from "#/server/services/workspace-machines";

function runWithMachines<A>(
	run: (machines: WorkspaceMachines) => Promise<A>,
): Promise<A> {
	return Effect.runPromise(
		Effect.gen(function* () {
			const machines = yield* WorkspaceMachineService;
			return yield* Effect.tryPromise(() => run(machines));
		}).pipe(Effect.provide(FreestyleWorkspaceMachinesLive)),
	);
}

export const deleteOwnedProject = createServerFn({ method: "POST" })
	.validator((data: { projectId?: string }) => {
		const projectId = data.projectId?.trim() ?? "";
		if (!projectId) throw new Error("Select a project to remove.");
		return { projectId };
	})
	.handler(async ({ data }): Promise<{ id: string }> => {
		const user = await requireUser(getRequest().headers);
		try {
			await runWithMachines((machines) =>
				removeProjectMachine(machines, {
					userId: user.id,
					projectId: data.projectId,
				}),
			);
			return { id: data.projectId };
		} catch (cause) {
			if (cause instanceof Response) {
				throw new Error((await cause.text()) || "Project is not available.");
			}
			throw new Error(publicFailureMessage(cause));
		}
	});
