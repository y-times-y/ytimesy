import { Effect } from "effect";
import type { EnvironmentModelRequest } from "#/domain/environment-model";
import {
	blocksDuplicateProvision,
	canStartPrepare,
	type ProjectWorkspace,
} from "../../domain/project-workspace";
import { startAfterResponse } from "../adapters/after-response";
import {
	backgroundJobId,
	dispatchBackgroundJob,
} from "../adapters/background-job-dispatch";
import { database } from "../adapters/database";
import {
	activeEnvironmentSetup,
	latestEnvironmentBuild,
} from "../adapters/environment-build-steps";
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
import { resolveEnvironmentModel } from "./environment-model";
import { startEnvironmentMachineEarly } from "./environment-prestart";

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
 * The status the project's chat and Settings show: the workspace, its newest
 * build (a rebuild runs while the workspace stays ready) and what each
 * repository's active setup is.
 */
export async function workspaceStatusView(workspace: ProjectWorkspace) {
	const [build, setup] = await Promise.all([
		latestEnvironmentBuild(workspace.id),
		activeEnvironmentSetup(workspace.id),
	]);
	return { ...workspaceView(workspace), build, setup };
}

/**
 * "Send anyway" after a failed first build: the next build clones only, so
 * chats run on the plain checkout and the agent installs what it needs.
 */
export function prepareWithoutSetup(
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
		yield* Effect.tryPromise(() =>
			database().query(
				"update workspace set plain_setup_requested=true where id=$1 and user_id=$2",
				[workspace.id, userId],
			),
		);
		if (!canStartPrepare(workspace.status)) return workspace;
		return yield* enqueueProjectWorkspace(userId, workspace.projectId, queue);
	});
}

/**
 * Builds a ready project's environment again (Retry after a failed rebuild);
 * chats keep the current environment until the new one is ready.
 */
export function rebuildProjectWorkspace(
	userId: string,
	workspaceId: string,
	queue: WorkspaceJobQueue = postgresJobQueue,
	repairRequest?: EnvironmentModelRequest,
) {
	return Effect.gen(function* () {
		const workspace = yield* Effect.tryPromise(async () => {
			const owned = await workspaceForOwner(userId, workspaceId);
			if (!owned)
				throw new Response("Workspace is not available.", { status: 404 });
			return owned;
		});
		if (workspace.status !== "ready")
			return yield* retryProjectWorkspace(
				userId,
				workspaceId,
				queue,
				repairRequest,
			);
		const repairModel = yield* Effect.tryPromise(() =>
			resolveEnvironmentModel(userId, repairRequest),
		);
		const jobId = yield* Effect.tryPromise(() =>
			queue.enqueuePrepare(workspace.id, repairModel),
		);
		if (jobId)
			yield* Effect.tryPromise(() => saveLastJobId(workspace.id, jobId));
		return workspace;
	});
}

/**
 * Creates at most one workspace per project. In-flight or ready workspaces are
 * returned as-is so a retry cannot start a second machine.
 */
export function enqueueProjectWorkspace(
	userId: string,
	projectId: string,
	queue: WorkspaceJobQueue = postgresJobQueue,
	repairRequest?: EnvironmentModelRequest,
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
		const repairModel = yield* Effect.tryPromise(() =>
			resolveEnvironmentModel(userId, repairRequest),
		);
		const workspace = existing
			? ((yield* Effect.tryPromise(() =>
					markWorkspaceQueued(userId, existing.id),
				)) ?? existing)
			: yield* Effect.tryPromise(() =>
					insertQueuedWorkspace(userId, projectId),
				);
		// A first build's machine boots while this request and the build's
		// dispatch finish; the build takes it (environment-prestart.ts).
		if (!workspace.templateSnapshotId)
			startAfterResponse(() => startEnvironmentMachineEarly(workspace.id));
		const jobId = yield* Effect.tryPromise(() =>
			queue.enqueuePrepare(workspace.id, repairModel).catch(async () => {
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
		// A new project's setup chat starts on the server, tab open or not; its
		// request waits there for this build (project-setup-background.ts). A
		// lost dispatch is caught when the first build is ready.
		if (!existing)
			yield* Effect.promise(() =>
				dispatchBackgroundJob({
					id: backgroundJobId(`project-setup:${workspace.id}`),
					kind: "project-setup",
					workspaceId: workspace.id,
				}).catch(() => false),
			);
		return workspace;
	});
}

export function retryProjectWorkspace(
	userId: string,
	workspaceId: string,
	queue: WorkspaceJobQueue = postgresJobQueue,
	repairRequest?: EnvironmentModelRequest,
) {
	return Effect.gen(function* () {
		const workspace = yield* Effect.tryPromise(async () => {
			const owned = await workspaceForOwner(userId, workspaceId);
			if (!owned)
				throw new Response("Workspace is not available.", { status: 404 });
			return owned;
		});
		if (!canStartPrepare(workspace.status)) return workspace;
		return yield* enqueueProjectWorkspace(
			userId,
			workspace.projectId,
			queue,
			repairRequest,
		);
	});
}
