import { Effect } from "effect";
import { branchSwitchBlockedReason } from "../../domain/project-workspace";
import type { ProjectSelection } from "../../domain/projects";
import { authorizedRepository, githubClient } from "../adapters/github";
import { projectForRepository, saveProject } from "../adapters/projects";
import {
	saveWorkspaceStatus,
	workspaceForProject,
} from "../adapters/workspaces";
import { githubAccessToken } from "../auth/github-connection";
import { enqueueProjectWorkspace } from "./workspaces";

const branchChangedMessage = "Branch changed. Retry to prepare this branch.";

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
		const [owner, repo] = repository.fullName.split("/");
		yield* Effect.tryPromise(() =>
			githubClient(token).repos.getBranch({
				owner,
				repo,
				branch: selection.branch,
			}),
		);
		let restartWorkspaceId: string | null = null;
		yield* Effect.tryPromise(async () => {
			const existing = await projectForRepository(
				userId,
				selection.repositoryId,
			);
			if (!existing) return;
			const workspace = await workspaceForProject(userId, existing.id);
			const blocked = branchSwitchBlockedReason(workspace?.status);
			if (blocked) throw new Response(blocked, { status: 409 });
			if (workspace?.status === "ready" && existing.branch !== selection.branch)
				restartWorkspaceId = workspace.id;
		});
		const project = yield* Effect.tryPromise(() =>
			saveProject(userId, repository, selection.branch),
		);
		const workspaceToRestart = restartWorkspaceId;
		if (workspaceToRestart)
			yield* Effect.tryPromise(() =>
				saveWorkspaceStatus(workspaceToRestart, "failed", branchChangedMessage),
			);
		yield* enqueue(userId, project.id);
		return project;
	});
}
