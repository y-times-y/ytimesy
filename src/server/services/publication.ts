import { Effect } from "effect";
import { copiedAgentMachineRef } from "../../domain/agent-session";
import { projectCheckoutFromFullName } from "../../domain/project-checkout";
import { publicFailureMessage } from "../../domain/project-workspace";
import { repositoriesForProject } from "../../domain/projects";
import {
	publicationBlockedReason,
	publicationCoAuthor,
	publicationCommitAuthor,
	publicationHeadBranch,
	publicationSessionBlockedReason,
	publicationWorkspaceBlockedReason,
	workspacePublicationBranch,
} from "../../domain/publication";
import { captureServerAnalytics } from "../adapters/analytics";
import { workspaceRuntimeFromEnv } from "../adapters/freestyle/workspace-runtime";
import { authorizedRepository, compareBranchAhead } from "../adapters/github";
import { ensureAppDraftPullRequest } from "../adapters/github/app-pull-request";
import { resolveGithubAppBot } from "../adapters/github/bot-identity";
import { pushBrokeredRepository } from "../adapters/github/git-broker";
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
		repositoryFullName?: string;
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
			const repositories = repositoriesForProject(owned);
			if (repositories.length > 1 && !input.repositoryFullName) {
				throw new Error(
					"Select the repository to publish for this multi-repository project.",
				);
			}
			const selected = input.repositoryFullName
				? repositories.find(
						(repo) => repo.fullName === input.repositoryFullName,
					)
				: repositories[0];
			if (!selected)
				throw new Response("Repository is not part of this project.", {
					status: 403,
				});
			return {
				...owned,
				...selected,
				isPrimaryRepository: selected.fullName === owned.fullName,
			};
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
		const chatBranch = project.isPrimaryRepository ? peeked.session : null;
		const base =
			input.baseBranch?.trim() ||
			chatBranch?.baseBranch ||
			repository.defaultBranch;
		const head =
			chatBranch?.workingBranch ||
			chatBranch?.taskBranch ||
			(input.sessionId
				? workspacePublicationBranch(input.sessionId)
				: publicationHeadBranch({
						selectedBranch: project.branch,
						defaultBranch: repository.defaultBranch,
						workspaceId: workspace.id,
					}));
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
		yield* Effect.tryPromise(() =>
			pushBrokeredRepository(
				{
					exec: (command, timeout) =>
						runtime.exec(providerRef, ["bash", "-lc", command], {}, timeout),
					writeTextFile: (path, contents) =>
						runtime.writeTextFile(providerRef, path, contents),
					readTextFile: async (path) => {
						if (!runtime.readTextFile)
							throw new Error("Workspace file transfer unavailable.");
						return runtime.readTextFile(providerRef, path);
					},
				},
				{
					owner: checkout.owner,
					name: checkout.name,
					branch: head,
					baseBranch: base,
					installationId: project.installationId,
					directory,
				},
			),
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
			ensureAppDraftPullRequest(project.installationId, repository.fullName, {
				title: input.title,
				body: input.body ?? "",
				head,
				base,
			}),
		);
		void captureServerAnalytics(
			userId,
			"pull_request_created",
			{},
			{
				key: pullRequest.url,
				timestamp: new Date(),
			},
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
