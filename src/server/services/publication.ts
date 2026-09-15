import { Effect } from "effect";
import { publicFailureMessage } from "../../domain/project-workspace";
import {
	publicationBlockedReason,
	publicationCommitAuthor,
	publicationHeadBranch,
	publicationWorkspaceBlockedReason,
} from "../../domain/publication";
import { workspaceRuntimeFromEnv } from "../adapters/freestyle/workspace-runtime";
import {
	authorizedRepository,
	compareBranchAhead,
	createDraftPullRequest,
} from "../adapters/github";
import { projectForOwner } from "../adapters/projects";
import {
	checkoutBranchArgv,
	commitAllArgv,
	githubPushEnv,
	pushBranchArgv,
	repositoryDirectory,
} from "../adapters/repository-setup";
import type { WorkspaceRuntime } from "../adapters/workspace-runtime";
import { readyWorkspaceForOwner } from "../adapters/workspaces";
import { githubAccessToken } from "../auth/github-connection";

/**
 * Commits and pushes the live workspace checkout, then opens a draft PR.
 * Does not publish until the user triggers this command.
 */
export function publishProject(
	userId: string,
	input: {
		projectId: string;
		title: string;
		body?: string;
		authorName?: string | null;
		authorEmail?: string | null;
	},
	runtime: WorkspaceRuntime = workspaceRuntimeFromEnv(),
) {
	return Effect.gen(function* () {
		const token = yield* Effect.tryPromise(() => githubAccessToken(userId));
		const project = yield* Effect.tryPromise(async () => {
			const owned = await projectForOwner(userId, input.projectId);
			if (!owned)
				throw new Response("Project is not available.", { status: 404 });
			return owned;
		});
		const workspace = yield* Effect.tryPromise(() =>
			readyWorkspaceForOwner(userId, input.projectId),
		);
		const workspaceBlocked = publicationWorkspaceBlockedReason(workspace);
		if (workspaceBlocked || !workspace?.providerRef) {
			return yield* reject(
				workspaceBlocked ?? "Prepare a workspace before publishing.",
			);
		}
		const repository = yield* Effect.tryPromise(() =>
			authorizedRepository(token, project.installationId, project.repositoryId),
		);
		const directory = repositoryDirectory(project.fullName);
		const author = publicationCommitAuthor({
			name: input.authorName,
			email: input.authorEmail,
		});
		const head = publicationHeadBranch({
			selectedBranch: project.branch,
			defaultBranch: repository.defaultBranch,
			workspaceId: workspace.id,
		});
		const providerRef = workspace.providerRef;
		yield* Effect.tryPromise(() =>
			runtime.recover(providerRef).catch((error) => {
				throw hostFailure(error, "Workspace is not available.");
			}),
		);
		const committed = yield* runGit(
			runtime,
			providerRef,
			commitAllArgv(directory, input.title, author),
			{},
			"Commit failed in the workspace.",
		);
		if (committed.exitCode !== 0)
			return yield* reject(
				committed.stderr.trim() ||
					committed.stdout.trim() ||
					"Commit failed in the workspace.",
			);
		const checkedOut = yield* runGit(
			runtime,
			providerRef,
			checkoutBranchArgv(directory, head),
			{},
			"Could not switch to the publication branch.",
		);
		if (checkedOut.exitCode !== 0)
			return yield* reject(
				checkedOut.stderr.trim() ||
					checkedOut.stdout.trim() ||
					"Could not switch to the publication branch.",
			);
		const pushed = yield* runGit(
			runtime,
			providerRef,
			pushBranchArgv(directory, head),
			githubPushEnv(token),
			"Push failed. Reconnect GitHub and retry.",
		);
		if (pushed.exitCode !== 0)
			return yield* reject(
				pushed.stderr.trim() ||
					pushed.stdout.trim() ||
					"Push failed. Reconnect GitHub and retry.",
			);
		const aheadBy = yield* Effect.tryPromise(() =>
			compareBranchAhead(
				token,
				repository.fullName,
				repository.defaultBranch,
				head,
			),
		);
		const blocked = publicationBlockedReason({
			head,
			base: repository.defaultBranch,
			aheadBy,
		});
		if (blocked) return yield* reject(blocked);
		return yield* Effect.tryPromise(() =>
			createDraftPullRequest(token, repository.fullName, {
				title: input.title,
				body: input.body ?? "",
				head,
				base: repository.defaultBranch,
			}),
		);
	});
}

function runGit(
	runtime: WorkspaceRuntime,
	providerRef: string,
	argv: string[],
	env: Record<string, string>,
	fallback: string,
) {
	return Effect.tryPromise(() =>
		runtime.exec(providerRef, argv, env, 120_000).catch((error) => {
			throw hostFailure(error, fallback);
		}),
	);
}

function reject(message: string) {
	return Effect.tryPromise(async () => {
		throw new Response(message, { status: 409 });
	});
}

function hostFailure(error: unknown, fallback: string) {
	if (error instanceof Response) return error;
	const message = publicFailureMessage(error);
	if (
		/not wired|FREESTYLE_API_KEY|Freestyle/i.test(message) ||
		message.includes("workspace host is connected")
	) {
		return new Response(
			"Workspace hosting is not connected. Retry after the workspace host is available.",
			{ status: 409 },
		);
	}
	return new Response(message || fallback, { status: 409 });
}
