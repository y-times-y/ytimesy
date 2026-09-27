import { Effect } from "effect";
import { copiedAgentMachineRef } from "../../domain/agent-session";
import { projectCheckoutFromFullName } from "../../domain/project-checkout";
import { publicFailureMessage } from "../../domain/project-workspace";
import {
	publicationBlockedReason,
	publicationCoAuthor,
	publicationCommitAuthor,
	publicationHeadBranch,
	publicationSessionBlockedReason,
	publicationWorkspaceBlockedReason,
	workspacePublicationBranch,
} from "../../domain/publication";
import {
	PROJECT_TOKEN_PATH,
	pushSelectedBranchScript,
} from "../adapters/freestyle/clone-project";
import { workspaceRuntimeFromEnv } from "../adapters/freestyle/workspace-runtime";
import {
	authorizedRepository,
	compareBranchAhead,
	createDraftPullRequest,
} from "../adapters/github";
import { resolveGithubAppBot } from "../adapters/github/bot-identity";
import { githubInstallationAccessToken } from "../adapters/github/installation-token";
import { projectForOwner } from "../adapters/projects";
import {
	checkoutBranchArgv,
	commitAllArgv,
	configureCommitAuthorArgv,
	repositoryDirectory,
} from "../adapters/repository-setup";
import type { WorkspaceRuntime } from "../adapters/workspace-runtime";
import { readyWorkspaceForOwner } from "../adapters/workspaces";
import { githubAccessToken } from "../auth/github-connection";
import { peekAgentSessionMachine } from "./agent-session-machine";

/**
 * Commits and pushes the live workspace checkout, then opens a draft PR.
 * Does not publish until the user triggers this command.
 */
export function publishProject(
	userId: string,
	input: {
		projectId: string;
		sessionId?: string;
		title: string;
		body?: string;
		baseBranch?: string;
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
		const checkout = projectCheckoutFromFullName({
			fullName: project.fullName,
			branch: project.branch,
			installationId: project.installationId,
		});
		if (!checkout) {
			return yield* reject("Repository name is missing.");
		}
		const workspace = yield* Effect.tryPromise(() =>
			readyWorkspaceForOwner(userId, input.projectId),
		);
		const workspaceBlocked = publicationWorkspaceBlockedReason(workspace);
		if (workspaceBlocked || !workspace) {
			return yield* reject(
				workspaceBlocked ?? "Prepare a workspace before publishing.",
			);
		}
		const peeked = yield* Effect.tryPromise(() =>
			peekAgentSessionMachine({
				userId,
				projectId: input.projectId,
				sessionId: input.sessionId,
			}),
		);
		const providerRef = copiedAgentMachineRef({
			sessionProviderRef: peeked.providerRef,
			templateProviderRef: workspace.providerRef,
		});
		const sessionBlocked = publicationSessionBlockedReason(providerRef);
		if (sessionBlocked || !providerRef) {
			return yield* reject(
				sessionBlocked ?? "Connect an agent before publishing.",
			);
		}
		const repository = yield* Effect.tryPromise(() =>
			authorizedRepository(token, project.installationId, project.repositoryId),
		);
		const directory = repositoryDirectory(project.fullName);
		const bot = yield* Effect.tryPromise(() => resolveGithubAppBot());
		const author = publicationCommitAuthor({
			name: input.authorName,
			email: input.authorEmail,
		});
		const coAuthor = publicationCoAuthor({ author, bot });
		const base = input.baseBranch?.trim() || repository.defaultBranch;
		const head = input.sessionId
			? workspacePublicationBranch(input.sessionId)
			: publicationHeadBranch({
					selectedBranch: project.branch,
					defaultBranch: repository.defaultBranch,
					workspaceId: workspace.id,
				});
		yield* Effect.tryPromise(() =>
			runtime.recover(providerRef).catch((error) => {
				throw hostFailure(error, "Workspace is not available.");
			}),
		);
		yield* runGit(
			runtime,
			providerRef,
			configureCommitAuthorArgv(directory, author),
			{},
			"Could not set the commit author.",
		);
		const committed = yield* runGit(
			runtime,
			providerRef,
			commitAllArgv(directory, input.title, author, coAuthor),
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
		const installationToken = yield* Effect.tryPromise(() =>
			githubInstallationAccessToken(project.installationId),
		);
		yield* Effect.tryPromise(() =>
			runtime
				.writeTextFile(
					providerRef,
					PROJECT_TOKEN_PATH,
					`${installationToken}\n`,
				)
				.catch((error) => {
					throw hostFailure(error, "Could not write the GitHub token.");
				}),
		);
		const pushed = yield* runGit(
			runtime,
			providerRef,
			[
				"bash",
				"-lc",
				pushSelectedBranchScript({
					owner: checkout.owner,
					name: checkout.name,
					branch: head,
					directory,
				}),
			],
			{},
			"Push failed. Reconnect GitHub and retry.",
		);
		if (pushed.exitCode !== 0)
			return yield* reject(
				pushed.stderr.trim() ||
					pushed.stdout.trim() ||
					"Push failed. Reconnect GitHub and retry.",
			);
		const aheadBy = yield* Effect.tryPromise(() =>
			compareBranchAhead(token, repository.fullName, base, head),
		);
		const blocked = publicationBlockedReason({
			head,
			base,
			aheadBy,
		});
		if (blocked) return yield* reject(blocked);
		const pullRequest = yield* Effect.tryPromise(() =>
			createDraftPullRequest(token, repository.fullName, {
				title: input.title,
				body: input.body ?? "",
				head,
				base,
			}),
		);
		return { ...pullRequest, head, base };
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
