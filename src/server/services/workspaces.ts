import { Effect } from "effect";
import {
	blocksDuplicateProvision,
	canStartPrepare,
	type ProjectWorkspace,
} from "../../domain/project-workspace";
import { projectForOwner } from "../adapters/projects";
import {
	insertQueuedWorkspace,
	markWorkspaceQueued,
	recordWorkspaceEvent,
	saveLastJobId,
	workspaceForOwner,
	workspaceForProject,
} from "../adapters/workspaces";
import { postgresJobQueue, type WorkspaceJobQueue } from "../jobs/queue";

export function workspaceView(workspace: ProjectWorkspace) {
	return {
		id: workspace.id,
		projectId: workspace.projectId,
		status: workspace.status,
		errorMessage: workspace.errorMessage,
		updatedAt: workspace.updatedAt,
	};
}

/**
 * Creates at most one workspace per project. In-flight or ready workspaces are
 * returned as-is so a retry cannot start a second machine.
 */
export function enqueueProjectWorkspace(
	userId: string,
	projectId: string,
	queue: WorkspaceJobQueue = postgresJobQueue,
) {
	return Effect.gen(function* () {
		yield* Effect.tryPromise(async () => {
			if (!(await projectForOwner(userId, projectId)))
				throw new Response("Project is not available.", { status: 404 });
		});
		const existing = yield* Effect.tryPromise(() =>
			workspaceForProject(userId, projectId),
		);
		if (existing && blocksDuplicateProvision(existing.status)) return existing;
		if (existing && !canStartPrepare(existing.status)) return existing;
		const workspace = existing
			? ((yield* Effect.tryPromise(() =>
					markWorkspaceQueued(userId, existing.id),
				)) ?? existing)
			: yield* Effect.tryPromise(() =>
					insertQueuedWorkspace(userId, projectId),
				);
		const jobId = yield* Effect.tryPromise(() =>
			queue.enqueuePrepare(workspace.id).catch(async () => {
				await recordWorkspaceEvent(
					userId,
					workspace.id,
					"Job queue is unavailable. Retry after the worker is running.",
				);
				return null;
			}),
		);
		if (jobId)
			yield* Effect.tryPromise(() => saveLastJobId(workspace.id, jobId));
		return workspace;
	});
}

export function retryProjectWorkspace(
	userId: string,
	workspaceId: string,
	queue: WorkspaceJobQueue = postgresJobQueue,
) {
	return Effect.gen(function* () {
		const workspace = yield* Effect.tryPromise(async () => {
			const owned = await workspaceForOwner(userId, workspaceId);
			if (!owned)
				throw new Response("Workspace is not available.", { status: 404 });
			return owned;
		});
		if (!canStartPrepare(workspace.status)) return workspace;
		return yield* enqueueProjectWorkspace(userId, workspace.projectId, queue);
	});
}
