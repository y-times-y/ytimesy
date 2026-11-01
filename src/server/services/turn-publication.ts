import { turnPublicationRole } from "#/domain/agent-task";
import { posixShellQuoted } from "#/domain/posix-command";
import { repositoriesForProject } from "#/domain/projects";
import {
	changedPathsFromDiff,
	type PullRequestHandoffFacts,
	pullRequestHandoffBody,
} from "#/domain/pull-request-handoff";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import { adoptChatPublicationBranch } from "../adapters/agent-sessions";
import { isDevEvalUser } from "../adapters/dev-eval-users";
import { isEnvironmentSetupChat } from "../adapters/environment-setup-chats";
import { authorizedRepository, compareBranchAhead } from "../adapters/github";
import { ensureAppDraftPullRequest } from "../adapters/github/app-pull-request";
import { pushBrokeredRepository } from "../adapters/github/git-broker";
import { evaluationRunForTask } from "../adapters/harness-evaluation";
import { projectForOwner } from "../adapters/projects";
import { repositoryDirectory } from "../adapters/repository-setup";
import type { WorkspaceRuntime } from "../adapters/workspace-runtime";
import { githubAccessToken } from "../auth/github-connection";
import { queuePullRequestEvidence } from "./pr-evidence-job";
import { availableChatBranchName, projectBaseBranch } from "./session-branch";

export type TurnGitRuntime = Pick<WorkspaceRuntime, "exec"> &
	Partial<Pick<WorkspaceRuntime, "readTextFile" | "writeTextFile">>;

/** Where a completed turn landed on GitHub; null branch when nothing was pushed. */
export type TurnPublication = {
	readonly branch: string | null;
	readonly pullRequestUrl: string | null;
};

/** A root chat's turn was kept local on purpose; the message is shown in the chat. */
export class ChatPublicationSkipped extends Error {}

/** The last revision this checkout pushed, so a turn that changed nothing pushes nothing. */
const PUBLISHED_REF = "refs/ytimesy/published";

/**
 * Evaluation runs (Terminal-Bench, isolated harness) and throwaway dev eval
 * users (hard set, side-by-side evals) never reach GitHub: eval users' projects
 * are copies of their owner's rows, pointing at the owner's real repository.
 * Nor does an environment-setup chat: its build and install commands can
 * regenerate tracked files, and setting up must never open a pull request.
 */
export async function turnPublicationExcluded(
	session: Pick<AgentSessionRecord, "userId" | "id">,
) {
	if (await isDevEvalUser(session.userId)) return true;
	if (await isEnvironmentSetupChat(session.userId, session.id)) return true;
	return Boolean(await evaluationRunForTask(session.userId, session.id));
}

/**
 * Draft handoff happens before completion, without accepting or merging the
 * task. A root chat pushes its own `ytimesy/` branch and keeps one draft PR
 * open on it; follow-up turns push to the same branch, updating the PR.
 */
const EMPTY_HANDOFF: PullRequestHandoffFacts = {
	description: null,
	finalAnswer: null,
	files: [],
	verification: [],
};

export async function publishCompletedSessionTurn(
	session: AgentSessionRecord,
	runtime: TurnGitRuntime,
	turn: string,
	facts: PullRequestHandoffFacts = EMPTY_HANDOFF,
): Promise<TurnPublication | undefined> {
	if (!/^[a-f0-9]{64}$/.test(turn))
		throw new Error("Invalid turn handoff identity.");
	const revision = `refs/ytimesy/turn-commits/${turn}`;
	if (turnPublicationRole(session) !== "chat") return;
	if (await turnPublicationExcluded(session)) return;
	const project = await projectForOwner(session.userId, session.projectId);
	if (!project)
		throw new Error("The chat's project is unavailable for automatic handoff.");
	const providerRef = session.providerRef;
	if (!providerRef) return;
	// A chat publishes only its own working branch (taken below if it has
	// none yet).
	let head = session.workingBranch;
	let chatBase = session.baseBranch;
	let token: string | undefined;
	let published: TurnPublication | undefined;
	const repositories = repositoriesForProject(project);
	for (const repo of repositories) {
		const directory = repositoryDirectory(repo.fullName);
		const changed = await runtime.exec(
			providerRef,
			["bash", "-lc", unpublishedCommitCountCommand(directory, revision)],
			{},
			15_000,
		);
		if (changed.exitCode !== 0)
			throw new Error(`Could not check committed changes in ${repo.fullName}.`);
		if (changed.stdout.trim() === "0") continue;
		token ??= await githubAccessToken(session.userId);
		const repository = await authorizedRepository(
			token,
			repo.installationId,
			repo.repositoryId,
		);
		if (!head) {
			// A chat opened before chats published: it takes its branch now,
			// once, and its checkout moves onto it so later turns stay there.
			const primaryRepo =
				repositories.find((each) => each.fullName === project.fullName) ?? repo;
			const primaryRepository =
				primaryRepo === repo
					? repository
					: await authorizedRepository(
							token,
							primaryRepo.installationId,
							primaryRepo.repositoryId,
						);
			const adopted = await adoptChatPublicationBranch(
				session.userId,
				session.id,
				await availableChatBranchName({
					userId: session.userId,
					projectId: session.projectId,
					sessionId: session.id,
					title: chatBranchTitle(session),
					token,
					fullName: primaryRepository.fullName,
				}),
				projectBaseBranch(project, primaryRepository),
			);
			head = adopted.workingBranch;
			chatBase = adopted.baseBranch;
			if (!head) throw new Error("The chat's branch could not be saved.");
			const moved = await runtime.exec(
				providerRef,
				[
					"bash",
					"-lc",
					`git -C ${posixShellQuoted(repositoryDirectory(project.fullName))} checkout -B ${posixShellQuoted(head)}`,
				],
				{},
				15_000,
			);
			if (moved.exitCode !== 0)
				throw new Error(`Could not move the chat's checkout onto ${head}.`);
		}
		const primary = repo.fullName === project.fullName;
		const base = primary
			? chatBase || projectBaseBranch(project, repository)
			: repo.branch || repository.defaultBranch;
		if (head === base || head === repository.defaultBranch)
			throw new ChatPublicationSkipped(
				`Changes are committed in this chat but were not pushed: it works directly on ${head}, and ytimesy never pushes to a base or default branch automatically. Start a new chat to get its own branch.`,
			);
		await pushBrokeredRepository(
			{
				exec: (command, timeout) =>
					runtime.exec(providerRef, ["bash", "-lc", command], {}, timeout),
				writeTextFile: (path, contents) => {
					if (!runtime.writeTextFile)
						throw new Error("Workspace file transfer unavailable.");
					return runtime.writeTextFile(providerRef, path, contents);
				},
				readTextFile: (path) => {
					if (!runtime.readTextFile)
						throw new Error("Workspace file transfer unavailable.");
					return runtime.readTextFile(providerRef, path);
				},
			},
			{
				owner: repo.fullName.split("/")[0],
				userId: session.userId,
				projectId: project.id,
				name: repo.fullName.split("/")[1],
				branch: head,
				baseBranch: base,
				installationId: repo.installationId,
				directory,
				revision,
			},
		);
		if ((await compareBranchAhead(token, repo.fullName, base, head)) < 1) {
			await markPublished(runtime, providerRef, directory, revision);
			if (primary) published = { branch: head, pullRequestUrl: null };
			continue;
		}
		const files = await changedFilesOnBranch(
			runtime,
			providerRef,
			directory,
			revision,
		);
		const pull = await ensureAppDraftPullRequest(
			repo.installationId,
			repo.fullName,
			{
				title:
					session.title.replace(/\s+/g, " ").trim().slice(0, 100) ||
					"Agent changes",
				body: pullRequestHandoffBody({
					description: facts.description,
					finalAnswer: facts.finalAnswer,
					files: [...facts.files, ...files],
					verification: facts.verification,
				}),
				head,
				base,
			},
			{
				userId: session.userId,
				projectId: session.projectId,
				repositoryId: repo.repositoryId,
				sessionId: session.id,
			},
			token,
		);
		// Harness-captured evidence (prEvidence=on) runs as a background job after
		// the handoff; queueing never blocks or fails the turn.
		if (primary && "number" in pull && typeof pull.number === "number")
			await queuePullRequestEvidence({
				userId: session.userId,
				sessionId: session.id,
				revision,
				installationId: Number(repo.installationId),
				fullName: repo.fullName,
				pullNumber: pull.number,
			}).catch((error) =>
				console.warn("Pull request evidence could not be queued.", {
					message:
						error instanceof Error ? error.message.slice(0, 300) : "unknown",
				}),
			);
		await markPublished(runtime, providerRef, directory, revision);
		if (primary) published = { branch: head, pullRequestUrl: pull.url };
	}
	return published;
}

/** Paths this branch changed since its base. A failed listing does not block the pull request. */
async function changedFilesOnBranch(
	runtime: TurnGitRuntime,
	providerRef: string,
	directory: string,
	revision: string,
) {
	const diff = await runtime
		.exec(
			providerRef,
			[
				"bash",
				"-lc",
				`git -C ${posixShellQuoted(directory)} diff --name-only -z ${posixShellQuoted(`refs/ytimesy/base..${revision}`)}`,
			],
			{},
			15_000,
		)
		.catch(() => null);
	if (diff?.exitCode !== 0) return [];
	return changedPathsFromDiff(diff.stdout);
}

/** The chat's first request names its branch, like a new chat's first send. */
function chatBranchTitle(session: AgentSessionRecord) {
	return session.title === "New session" ? "" : session.title;
}

/** Commits since the chat's base, or 0 when this exact revision was already pushed. */
function unpublishedCommitCountCommand(directory: string, revision: string) {
	const git = `git -C ${posixShellQuoted(directory)}`;
	return `if [ "$(${git} rev-parse -q --verify ${revision} || true)" = "$(${git} rev-parse -q --verify ${PUBLISHED_REF} || echo none)" ]; then echo 0; else ${git} rev-list --count refs/ytimesy/base..${revision}; fi`;
}

async function markPublished(
	runtime: TurnGitRuntime,
	providerRef: string,
	directory: string,
	revision: string,
) {
	await runtime
		.exec(
			providerRef,
			[
				"bash",
				"-lc",
				`git -C ${posixShellQuoted(directory)} update-ref ${PUBLISHED_REF} ${revision}`,
			],
			{},
			15_000,
		)
		.catch(() => undefined);
}
