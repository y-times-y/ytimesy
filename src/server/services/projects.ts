import { Effect } from "effect";
import {
	addedProjectBranch,
	singleRepositoryProject,
} from "../../domain/add-project";
import { WorkspaceId } from "../../domain/ids";
import { branchSwitchBlockedReason } from "../../domain/project-workspace";
import {
	type ProjectGroupSelection,
	type ProjectRepository,
	type ProjectSelection,
	projectFolderName,
	projectMachineRefsToDestroy,
	type RepositoryChoice,
} from "../../domain/projects";
import {
	isGeneratedSessionBranch,
	sessionBranchChangeRestartsWorkspace,
} from "../../domain/session-branch";
import { listProjectProviderRefs } from "../adapters/agent-sessions";
import { captureServerAnalytics } from "../adapters/analytics";
import {
	authorizedRepository,
	createAuthorizedRepository,
	repositoryBranchSha,
} from "../adapters/github";
import {
	deleteProjectForOwner,
	listProjects,
	projectForOwner,
	projectForRepository,
	refreshProjectRepository,
	saveProject,
	saveProjectGroup,
} from "../adapters/projects";
import {
	saveWorkspaceStatus,
	workspaceForProject,
} from "../adapters/workspaces";
import { githubAccessToken } from "../auth/github-connection";
import { rejectRequest } from "./errors";
import type { WorkspaceMachines } from "./workspace-machines";
import { enqueueProjectWorkspace } from "./workspaces";

/** A missing branch is the user's to fix, not a GitHub outage. */
function requireBranch(token: string, fullName: string, branch: string) {
	return Effect.gen(function* () {
		const sha = yield* Effect.tryPromise(() =>
			repositoryBranchSha(token, fullName, branch),
		);
		if (!sha)
			return yield* rejectRequest(
				`Branch ${branch} does not exist in ${fullName}.`,
				400,
			);
	});
}

const branchChangedMessage = "Branch changed. Retry to prepare this branch.";

/**
 * Before an existing project's branch is overwritten: refuses while its
 * workspace is busy, and returns the ready workspace that must be marked
 * failed afterwards so Retry clones the new branch (null when none).
 */
async function workspaceToRestartForBranch(
	userId: string,
	existing: { id: string; branch: string },
	repository: { fullName: string; repositoryId: number; defaultBranch: string },
	branch: string,
) {
	const workspace = await workspaceForProject(userId, existing.id);
	const blocked = branchSwitchBlockedReason(workspace?.status);
	if (blocked) throw new Response(blocked, { status: 409 });
	return workspace?.status === "ready" &&
		sessionBranchChangeRestartsWorkspace({
			from: existing.branch,
			to: branch,
			defaultBranch: repository.defaultBranch,
			title: projectFolderName(repository.fullName),
			id: String(repository.repositoryId),
		})
		? workspace.id
		: null;
}

export function connectProjectGroup(
	userId: string,
	selection: ProjectGroupSelection,
) {
	return Effect.gen(function* () {
		const token = yield* Effect.tryPromise(() => githubAccessToken(userId));
		const repositories: ProjectRepository[] = [];
		const authorized: RepositoryChoice[] = [];
		for (const selected of selection.repositories) {
			const repository = yield* Effect.tryPromise(() =>
				authorizedRepository(
					token,
					selected.installationId,
					selected.repositoryId,
				),
			);
			const branch = isGeneratedSessionBranch(selected.branch)
				? repository.defaultBranch
				: selected.branch;
			yield* requireBranch(token, repository.fullName, branch);
			repositories.push({ ...repository, branch });
			authorized.push(repository);
		}
		// Existing tools address checkouts by basename; reject ambiguous directory names.
		if (
			new Set(repositories.map((repo) => projectFolderName(repo.fullName)))
				.size !== repositories.length
		)
			return yield* rejectRequest(
				"Repositories in one project must have different folder names.",
				400,
			);
		// Adding a repository that already has its own project opens that
		// project, refreshing its Git access (a reinstalled GitHub App has a new
		// installation id; a renamed or transferred repository a new full name).
		const existing =
			repositories.length === 1
				? singleRepositoryProject(
						yield* Effect.tryPromise(() => listProjects(userId)),
						repositories[0].repositoryId,
					)
				: undefined;
		if (existing) {
			// The add form always sends the repository's default branch, so only
			// another branch is the user's choice; re-adding to repair Git access
			// keeps the project's branch (it may be on a feature branch).
			const chosen = repositories[0].branch;
			const repository = {
				...repositories[0],
				branch:
					chosen === authorized[0].defaultBranch ? existing.branch : chosen,
			};
			const restartWorkspaceId =
				existing.branch === repository.branch
					? null
					: yield* Effect.tryPromise(() =>
							workspaceToRestartForBranch(
								userId,
								existing,
								authorized[0],
								repository.branch,
							),
						);
			// The form defaults the name to the repository's folder name; only a
			// name the user typed renames the project.
			const typedName =
				selection.name !== projectFolderName(repository.fullName)
					? selection.name
					: null;
			const project = yield* Effect.tryPromise(() =>
				refreshProjectRepository(userId, existing.id, repository, typedName),
			);
			if (restartWorkspaceId)
				yield* Effect.tryPromise(() =>
					saveWorkspaceStatus(
						restartWorkspaceId,
						"failed",
						branchChangedMessage,
					),
				);
			yield* enqueueProjectWorkspace(userId, project.id);
			return project;
		}
		const project = yield* Effect.tryPromise(() =>
			saveProjectGroup(userId, selection.name, repositories),
		);
		void captureServerAnalytics(
			userId,
			"project_connected",
			{ repositories: repositories.length },
			{ key: project.id, timestamp: new Date() },
		);
		yield* enqueueProjectWorkspace(userId, project.id);
		return project;
	});
}

/**
 * Saves the authorized repository and branch. A ready workspace whose branch
 * changed is marked failed so enqueue/Retry can clone the new checkout;
 * in-flight preparation is left alone.
 */
export function connectProject(
	userId: string,
	selection: ProjectSelection,
	enqueue = enqueueProjectWorkspace,
) {
	return Effect.gen(function* () {
		const token = yield* Effect.tryPromise(() => githubAccessToken(userId));
		const repository = yield* Effect.tryPromise(() =>
			authorizedRepository(
				token,
				selection.installationId,
				selection.repositoryId,
			),
		);
		const storedBranch = isGeneratedSessionBranch(selection.branch)
			? repository.defaultBranch
			: selection.branch;
		if (!isGeneratedSessionBranch(storedBranch))
			yield* requireBranch(token, repository.fullName, storedBranch);
		const existing = yield* Effect.tryPromise(() =>
			projectForRepository(userId, selection.repositoryId),
		);
		const restartWorkspaceId = existing
			? yield* Effect.tryPromise(() =>
					workspaceToRestartForBranch(
						userId,
						existing,
						repository,
						storedBranch,
					),
				)
			: null;
		const project = yield* Effect.tryPromise(() =>
			saveProject(userId, repository, storedBranch),
		);
		void captureServerAnalytics(
			userId,
			"project_connected",
			{ repositories: 1 },
			{ key: project.id, timestamp: new Date() },
		);
		if (restartWorkspaceId)
			yield* Effect.tryPromise(() =>
				saveWorkspaceStatus(restartWorkspaceId, "failed", branchChangedMessage),
			);
		yield* enqueue(userId, project.id);
		return project;
	});
}

export function createScratchProject(
	userId: string,
	name: string,
	enqueue = enqueueProjectWorkspace,
) {
	return Effect.gen(function* () {
		const token = yield* Effect.tryPromise(() => githubAccessToken(userId));
		const repository = yield* Effect.tryPromise(() =>
			createAuthorizedRepository(token, name),
		);
		const project = yield* Effect.tryPromise(() =>
			saveProject(userId, repository, addedProjectBranch(repository)),
		);
		void captureServerAnalytics(
			userId,
			"project_connected",
			{ repositories: 1 },
			{ key: project.id, timestamp: new Date() },
		);
		yield* enqueue(userId, project.id);
		return project;
	});
}

/**
 * Drops this ytimesy project and its template/session VMs. The GitHub
 * repository stays; the same repo can be added again from the picker.
 * Freestyle destroy failures are ignored so the sidebar can clear; leftover
 * machines are reclaimed by the idle timeout.
 */
export async function removeProjectMachine(
	machines: Pick<WorkspaceMachines, "destroy">,
	input: {
		readonly userId: string;
		readonly projectId: string;
	},
) {
	const project = await projectForOwner(input.userId, input.projectId);
	if (!project) throw new Error("Project is not available.");
	const workspace = await workspaceForProject(input.userId, input.projectId);
	const refs = projectMachineRefsToDestroy({
		sessionProviderRefs: await listProjectProviderRefs(
			input.userId,
			input.projectId,
		),
		templateProviderRef: workspace?.providerRef,
	});
	for (const ref of refs) {
		try {
			await machines.destroy(WorkspaceId(ref));
		} catch {
			// Idle timeout reclaims machines that Freestyle did not delete.
		}
	}
	await deleteProjectForOwner(input.userId, input.projectId);
}
