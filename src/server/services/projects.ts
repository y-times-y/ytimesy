import { Effect } from "effect";
import {
	addedProjectBranch,
	singleRepositoryProject,
} from "../../domain/add-project";
import { AuthSnapshotId, WorkspaceId } from "../../domain/ids";
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
import { projectCleanupTargets } from "../adapters/account-deletion";
import { captureServerAnalytics } from "../adapters/analytics";
import {
	checkpointStorageConfigured,
	removeChatObjects,
} from "../adapters/checkpoints/storage";
import {
	authorizedRepository,
	createAuthorizedRepository,
	repositoryBranchSha,
} from "../adapters/github";
import { removeHandoffObjects } from "../adapters/handoff-store";
import {
	deleteProjectForOwner,
	listProjects,
	projectForOwner,
	projectForRepository,
	refreshProjectRepository,
	saveProject,
	saveProjectGroup,
} from "../adapters/projects";
import { purgeConversationState } from "../adapters/realtime-delivery";
import {
	saveWorkspaceStatus,
	workspaceForProject,
} from "../adapters/workspaces";
import { githubAccessToken } from "../auth/github-connection";
import { CLEANUP_CONCURRENCY, eachLimited } from "./account-deletion";
import { cancelServerTurn } from "./cancel-server-turn";
import { rejectRequest } from "./errors";
import { removeProjectPullRequestEvidence } from "./pr-evidence-cleanup";
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
	/**
	 * An empty repository (no initial commit) that the caller pushes its own
	 * history into (a local folder imported by `ytimesy continue`). Its
	 * environment is prepared only once that push landed, by the caller.
	 */
	options: { readonly empty?: boolean } = {},
) {
	return Effect.gen(function* () {
		const token = yield* Effect.tryPromise(() => githubAccessToken(userId));
		const repository = yield* Effect.tryPromise(() =>
			createAuthorizedRepository(token, name, { autoInit: !options.empty }),
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
		if (!options.empty) yield* enqueue(userId, project.id);
		return { project, repository };
	});
}

/**
 * Drops this ytimesy project and what it owns, mirroring account deletion:
 * its chats' stored checkpoints, context archives and attachments, its pull
 * request evidence, then its rows, then its VMs and private snapshots. The
 * GitHub repository stays; the same repo can be added again from the picker.
 *
 * Storage failures stop before any row is deleted, so a retry finds
 * everything again. Provider resources go only once the rows are gone; a
 * destroy failure is logged and left to expire (VMs by their idle timeout)
 * so the sidebar can clear.
 */
export async function removeProjectMachine(
	machines: Pick<WorkspaceMachines, "destroy" | "destroySnapshot">,
	input: {
		readonly userId: string;
		readonly projectId: string;
	},
) {
	const project = await projectForOwner(input.userId, input.projectId);
	if (!project) throw new Error("Project is not available.");
	const workspace = await workspaceForProject(input.userId, input.projectId);
	const targets = await projectCleanupTargets(input.userId, input.projectId);
	// Running turns stop before their chats' state goes (cancel, then purge).
	await eachLimited(targets.sessionIds, CLEANUP_CONCURRENCY, (sessionId) =>
		cancelServerTurn(input.userId, sessionId),
	).catch(() => {
		throw new Response(
			"The project was not removed because a running turn could not be stopped. Try again.",
			{ status: 503 },
		);
	});
	if (checkpointStorageConfigured())
		await eachLimited(targets.sessionIds, CLEANUP_CONCURRENCY, (sessionId) =>
			removeChatObjects(input.userId, sessionId),
		).catch(() => {
			throw new Response(
				"The project was not removed because its saved chat files could not be deleted. Try again.",
				{ status: 503 },
			);
		});
	await eachLimited(targets.sessionIds, CLEANUP_CONCURRENCY, (sessionId) =>
		purgeConversationState(input.userId, sessionId),
	).catch(() => {
		throw new Response(
			"The project was not removed because its chats' state could not be deleted. Try again.",
			{ status: 503 },
		);
	});
	// Pull request evidence media in private storage; its rows cascade with the project.
	await removeProjectPullRequestEvidence(input.userId, input.projectId);
	// Its imported local sessions; their rows cascade with the project.
	await removeHandoffObjects(input.userId, input.projectId).catch(() => {
		throw new Response(
			"The project was not removed because its imported sessions could not be deleted. Try again.",
			{ status: 503 },
		);
	});
	await deleteProjectForOwner(input.userId, input.projectId);
	const refs = projectMachineRefsToDestroy({
		sessionProviderRefs: targets.vmIds,
		templateProviderRef: workspace?.providerRef,
	});
	const sharedToolsSnapshot = process.env.YTIMESY_TOOLS_SNAPSHOT_ID?.trim();
	const leftovers: string[] = [];
	await eachLimited(refs, CLEANUP_CONCURRENCY, (ref) =>
		machines.destroy(WorkspaceId(ref)).catch(() => {
			leftovers.push(`vm:${ref}`);
		}),
	);
	await eachLimited(
		targets.snapshotIds.filter((id) => id !== sharedToolsSnapshot),
		CLEANUP_CONCURRENCY,
		(snapshotId) =>
			machines.destroySnapshot(AuthSnapshotId(snapshotId)).catch(() => {
				leftovers.push(`snapshot:${snapshotId}`);
			}),
	);
	if (leftovers.length)
		console.warn("Project removal left provider resources to expire.", {
			projectId: input.projectId,
			leftovers,
		});
}
