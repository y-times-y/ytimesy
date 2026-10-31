import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { Effect } from "effect";
import type { ArchivedKind } from "#/domain/archive";
import { publicFailureMessage } from "#/domain/project-workspace";
import { listArchived } from "#/server/adapters/archive";
import { FreestyleWorkspaceMachinesLive } from "#/server/adapters/freestyle/live";
import { requireUser } from "#/server/auth/auth";
import { requireSameOrigin } from "#/server/http";
import {
	archiveOwned,
	deleteArchived,
	restoreOwned,
} from "#/server/services/archive";
import { WorkspaceMachineService } from "#/server/services/capabilities";
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
			// Archived, not deleted: Settings > Archived restores it for 30 days.
			await archiveOwned(user.id, "project", data.projectId);
			return { id: data.projectId };
		} catch (cause) {
			if (cause instanceof Response) {
				throw new Error((await cause.text()) || "Project is not available.");
			}
			throw new Error(publicFailureMessage(cause));
		}
	});

const archivedInput = (data: {
	kind?: string;
	id?: string;
	projectId?: string;
}): { kind: ArchivedKind; id: string; projectId: string } => {
	const kind =
		data.kind === "project" ? "project" : data.kind === "chat" ? "chat" : null;
	const id = data.id?.trim() ?? "";
	const projectId = data.projectId?.trim() ?? "";
	if (!kind || !id || !projectId) throw new Error("Select an archived item.");
	return { kind, id, projectId };
};

/** Settings > Archived: archived projects and chats, newest first. */
export const listArchivedFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const user = await requireUser(getRequest().headers);
		return listArchived(user.id);
	},
);

export const restoreArchivedFn = createServerFn({ method: "POST" })
	.validator(archivedInput)
	.handler(async ({ data }) => {
		requireSameOrigin(getRequest());
		const user = await requireUser(getRequest().headers);
		await restoreOwned(user.id, data.kind, data.id);
		return { id: data.id };
	});

/** Deletes an archived item for good, before its 30 days end. */
export const deleteArchivedFn = createServerFn({ method: "POST" })
	.validator(archivedInput)
	.handler(async ({ data }) => {
		requireSameOrigin(getRequest());
		const user = await requireUser(getRequest().headers);
		try {
			await runWithMachines((machines) =>
				deleteArchived(machines, { userId: user.id, ...data }),
			);
			return { id: data.id };
		} catch (cause) {
			if (cause instanceof Response)
				throw new Error((await cause.text()) || "Could not delete it.");
			throw new Error(publicFailureMessage(cause));
		}
	});
