import { turnPublicationRole } from "#/domain/agent-task";
import { posixShellQuoted } from "#/domain/posix-command";
import { withAgentCapturesSection } from "#/domain/pr-evidence";
import { repositoriesForProject } from "#/domain/projects";
import type { PublicationAuthor } from "#/domain/publication";
import {
	changedPathsFromDiff,
	type PullRequestHandoffFacts,
	pullRequestHandoffBody,
} from "#/domain/pull-request-handoff";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import { adoptChatPublicationBranch } from "../adapters/agent-sessions";
import { isDevEvalUser } from "../adapters/dev-eval-users";
import { isEnvironmentSetupChat } from "../adapters/environment-setup-chats";
import {
	authorizedRepository,
	compareBranchAhead,
	findOpenPullRequest,
	isNothingAheadToOpen,
} from "../adapters/github";
import { ensureAppDraftPullRequest } from "../adapters/github/app-pull-request";
import { githubCommitIdentityForToken } from "../adapters/github/commit-identity";
import { pushBrokeredRepository } from "../adapters/github/git-broker";
import { evaluationRunForTask } from "../adapters/harness-evaluation";
import { projectForOwner } from "../adapters/projects";
import { repositoryDirectory } from "../adapters/repository-setup";
import type { WorkspaceRuntime } from "../adapters/workspace-runtime";
import { githubAccessToken } from "../auth/github-connection";
import {
	agentCapturesPullRequestSection,
	collectAgentCaptures,
} from "./agent-captures";
import { queuePullRequestEvidence } from "./pr-evidence-job";
import { availableChatBranchName, projectBaseBranch } from "./session-branch";
import { timed } from "./step-timing";

export type TurnGitRuntime = Pick<WorkspaceRuntime, "exec"> &
	Partial<Pick<WorkspaceRuntime, "readTextFile" | "writeTextFile">>;

/** Where a completed turn landed on GitHub; null branch when nothing was pushed. */
export type TurnPublication = {
	readonly branch: string | null;
	readonly pullRequestUrl: string | null;
	/** The pull request this turn opened or pushed to. */
	readonly pullRequest?: {
		readonly number: number;
		readonly url: string;
		readonly draft: boolean;
		/** Opened by this turn, not an open one it pushed to. */
		readonly created: boolean;
	};
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
	/**
	 * The repositories (full names) unpublishedTurnRepositories found with
	 * something to push; the others are skipped without asking the checkout
	 * or GitHub again. Omitted, every repository is checked.
	 */
	pending?: ReadonlySet<string>,
	/** Told the primary repository's pull request as soon as GitHub returns it. */
	onPullRequest?: (
		pull: NonNullable<TurnPublication["pullRequest"]>,
	) => unknown,
	/**
	 * A turn that added nothing still opens the pull request of a branch that
	 * was pushed (by an earlier turn or by the agent) and has none open.
	 */
	openMissingPullRequest = false,
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
	// Screenshots and recordings the agent made after its last command (a
	// recording it ran in the background) are stored before the description
	// lists them; collecting them runs beside the push.
	const capturesCollected = timed("handoff:captures", () =>
		collectAgentCaptures({
			shell: (command, timeout) =>
				runtime.exec(providerRef, ["bash", "-lc", command], {}, timeout),
			userId: session.userId,
			projectId: session.projectId,
			sessionId: session.id,
			itemId: null,
		}),
	).catch((error) =>
		console.warn("Agent captures were not collected at handoff.", {
			message: error instanceof Error ? error.message.slice(0, 300) : "unknown",
		}),
	);
	// A chat publishes only its own working branch (taken below if it has
	// none yet).
	let head = session.workingBranch;
	let chatBase = session.baseBranch;
	let tokenRead: Promise<string> | undefined;
	const userTokenFor = () => {
		tokenRead ??= timed("handoff:userToken", () =>
			githubAccessToken(session.userId),
		);
		return tokenRead;
	};
	let authorRead: Promise<PublicationAuthor | null> | undefined;
	const authorFor = () => {
		authorRead ??= userTokenFor()
			.then(githubCommitIdentityForToken)
			.catch(() => null);
		return authorRead;
	};
	let published: TurnPublication | undefined;
	const repositories = repositoriesForProject(project).filter(
		(repo) => !pending || pending.has(repo.fullName),
	);
	for (const repo of repositories) {
		const directory = repositoryDirectory(repo.fullName);
		// A repository known to have commits to push asks GitHub for access
		// while the checkout is checked; otherwise only after.
		const authorization = () =>
			userTokenFor().then((token) =>
				timed("handoff:authorizedRepository", () =>
					authorizedRepository(token, repo.installationId, repo.repositoryId),
				),
			);
		const early = pending ? authorization() : undefined;
		early?.catch(() => undefined);
		const changed = await timed("handoff:unpublished", () =>
			runtime.exec(
				providerRef,
				["bash", "-lc", unpublishedCommitCountCommand(directory, revision)],
				{},
				15_000,
			),
		);
		if (changed.exitCode !== 0)
			throw new Error(`Could not check committed changes in ${repo.fullName}.`);
		if (
			changed.stdout.trim() === "0" &&
			!(
				openMissingPullRequest &&
				repo.fullName === project.fullName &&
				(await branchLacksOpenPullRequest({
					runtime,
					providerRef,
					directory,
					branch: head,
					base: chatBase || repo.branch,
					fullName: repo.fullName,
					token: userTokenFor,
				}))
			)
		)
			continue;
		const repository = await (early ?? authorization());
		const token = await userTokenFor();
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
		const branch = head;
		const primary = repo.fullName === project.fullName;
		const base = primary
			? chatBase || projectBaseBranch(project, repository)
			: repo.branch || repository.defaultBranch;
		if (branch === base || branch === repository.defaultBranch)
			throw new ChatPublicationSkipped(
				`Changes are committed in this chat but were not pushed: it works directly on ${branch}, and ytimesy never pushes to a base or default branch automatically. Start a new chat to get its own branch.`,
			);
		// What the pull request needs and the push does not change runs beside
		// it: the open pull request's lookup, the changed paths and the
		// Evidence section (a count and a link to the agent's screenshots and
		// recordings in ytimesy, never media in the repository or body).
		const existing = timed("handoff:findPullRequest", () =>
			findOpenPullRequest(token, repo.fullName, { head: branch, base }),
		);
		existing.catch(() => undefined);
		const files = changedFilesOnBranch(
			runtime,
			providerRef,
			directory,
			revision,
		);
		const captures = primary
			? capturesCollected.then(() =>
					agentCapturesPullRequestSection({
						userId: session.userId,
						projectId: session.projectId,
						sessionId: session.id,
					}).catch(() => null),
				)
			: Promise.resolve(null);
		const author = await authorFor();
		await timed("handoff:push", () =>
			pushBrokeredRepository(
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
					branch,
					baseBranch: base,
					installationId: repo.installationId,
					directory,
					revision,
					author,
				},
			),
		);
		const [changedFiles, capturesSection] = await Promise.all([
			files,
			captures,
		]);
		// No separate "is it ahead" question: GitHub refuses to open a pull
		// request for a branch that adds nothing, and an open one is only
		// updated.
		const pull = await timed("handoff:pullRequest", () =>
			ensureAppDraftPullRequest(
				repo.installationId,
				repo.fullName,
				{
					title:
						session.title.replace(/\s+/g, " ").trim().slice(0, 100) ||
						"Agent changes",
					body: withAgentCapturesSection(
						pullRequestHandoffBody({
							description: facts.description,
							finalAnswer: facts.finalAnswer,
							files: [...facts.files, ...changedFiles],
							verification: facts.verification,
						}),
						capturesSection,
					),
					head: branch,
					base,
				},
				{
					userId: session.userId,
					projectId: session.projectId,
					repositoryId: repo.repositoryId,
					sessionId: session.id,
				},
				token,
				existing,
			),
		).catch(async (error: unknown) => {
			if (await isNothingAheadToOpen(error)) return null;
			throw error;
		});
		if (!pull) {
			await markPublished(runtime, providerRef, directory, revision);
			if (primary) published = { branch, pullRequestUrl: null };
			continue;
		}
		const pullNumber =
			"number" in pull && typeof pull.number === "number" ? pull.number : null;
		const pullRequest =
			pullNumber !== null
				? {
						number: pullNumber,
						url: pull.url,
						draft: "draft" in pull ? Boolean(pull.draft) : true,
						created: "created" in pull ? Boolean(pull.created) : false,
					}
				: undefined;
		await Promise.all([
			primary && pullRequest
				? Promise.resolve()
						.then(() => onPullRequest?.(pullRequest))
						.catch(() => undefined)
				: undefined,
			// Harness-captured evidence (prEvidence=on) runs as a background job
			// after the handoff; queueing never blocks or fails the turn.
			primary && pullNumber !== null
				? queuePullRequestEvidence({
						userId: session.userId,
						sessionId: session.id,
						revision,
						installationId: Number(repo.installationId),
						fullName: repo.fullName,
						pullNumber,
					}).catch((error) =>
						console.warn("Pull request evidence could not be queued.", {
							message:
								error instanceof Error
									? error.message.slice(0, 300)
									: "unknown",
						}),
					)
				: undefined,
			markPublished(runtime, providerRef, directory, revision),
		]);
		if (primary)
			published = {
				branch,
				pullRequestUrl: pull.url,
				...(pullRequest ? { pullRequest } : {}),
			};
	}
	return published;
}

/**
 * The repositories (full names) whose checkout holds this turn's commits not
 * yet pushed: a turn that changed nothing publishes nothing. One guest
 * command per repository, all at once.
 */
export async function unpublishedTurnRepositories(
	runtime: TurnGitRuntime,
	providerRef: string,
	repositories: readonly { fullName: string }[],
	turn: string,
): Promise<ReadonlySet<string>> {
	if (!/^[a-f0-9]{64}$/.test(turn))
		throw new Error("Invalid turn handoff identity.");
	const revision = `refs/ytimesy/turn-commits/${turn}`;
	const counts = await Promise.all(
		repositories.map(async (repo) => {
			const result = await runtime
				.exec(
					providerRef,
					[
						"bash",
						"-lc",
						unpublishedCommitCountCommand(
							repositoryDirectory(repo.fullName),
							revision,
						),
					],
					{},
					15_000,
				)
				.catch(() => null);
			// An unreadable checkout is left to publication, which says why.
			return result?.exitCode === 0 && result.stdout.trim() === "0"
				? null
				: repo.fullName;
		}),
	);
	return new Set(counts.filter((name): name is string => name !== null));
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

/**
 * Whether a branch this chat already pushed has commits beyond its base and no
 * open pull request: the one case a turn with nothing new still opens one.
 * Bookkeeping: any failure answers no and the turn goes on.
 */
async function branchLacksOpenPullRequest(input: {
	runtime: TurnGitRuntime;
	providerRef: string;
	directory: string;
	branch: string | null;
	base: string;
	fullName: string;
	token: () => Promise<string>;
}) {
	if (!input.branch || !input.base || input.branch === input.base) return false;
	try {
		const git = `git -C ${posixShellQuoted(input.directory)}`;
		const pushed = await input.runtime.exec(
			input.providerRef,
			[
				"bash",
				"-lc",
				`${git} rev-parse -q --verify ${PUBLISHED_REF} >/dev/null && echo yes || echo no`,
			],
			{},
			15_000,
		);
		if (pushed.stdout.trim() !== "yes") return false;
		const token = await input.token();
		const head = input.branch;
		if (
			await findOpenPullRequest(token, input.fullName, {
				head,
				base: input.base,
			})
		)
			return false;
		return (
			(await compareBranchAhead(token, input.fullName, input.base, head)) > 0
		);
	} catch {
		return false;
	}
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
