import { createHash } from "node:crypto";
import { posix } from "node:path";
import { turnPublicationRole } from "#/domain/agent-task";
import { publicFailureMessage } from "#/domain/project-workspace";
import {
	type Project,
	projectFolderName,
	repositoriesForProject,
} from "#/domain/projects";
import { handoffFactsFromItems } from "#/domain/pull-request-handoff";
import { branchFromGitHead } from "#/domain/session-branch";
import {
	lastAgentMessageText,
	lastUserMessageText,
	type SessionItem,
} from "#/domain/session-item";
import {
	type AgentSessionRecord,
	saveAgentWorkingBranch,
} from "../adapters/agent-sessions";
import { PROJECT_CWD_PATH } from "../adapters/freestyle/clone-project";
import { workspaceRuntimeFromEnv } from "../adapters/freestyle/workspace-runtime";
import { githubCommitIdentityForToken } from "../adapters/github/commit-identity";
import { MANAGED_GIT_BOT } from "../adapters/managed-git-identity";
import { projectForOwner } from "../adapters/projects";
import { repositoryDirectory } from "../adapters/repository-setup";
import { automaticTurnCommitArgv } from "../adapters/turn-commit";
import { githubAccessToken } from "../auth/github-connection";
import { timed } from "./step-timing";
import {
	ChatPublicationSkipped,
	publishCompletedSessionTurn,
	type TurnGitRuntime,
	type TurnPublication,
	turnPublicationExcluded,
	unpublishedTurnRepositories,
} from "./turn-publication";

/** What a root chat's turn did on GitHub, or why its changes stayed local. */
export type TurnCommitOutcome = {
	readonly publication?: TurnPublication;
	/** Shown in the chat when the changes were not committed or pushed. */
	readonly notice?: string;
};

/**
 * A root chat's turn committed in its checkout. `publish`, when the checkout
 * holds commits GitHub does not have yet, pushes the branch and opens or
 * updates the draft pull request: it runs after the turn is marked done (the
 * commit already keeps the work), and never throws for GitHub trouble.
 */
export type CommittedTurn = {
	/** Shown in the chat now: the changes were not committed, or why the author is ytimesy's. */
	readonly notice?: string;
	readonly publish?: (
		/** Told the pull request as soon as GitHub returns it, before the handoff's last steps. */
		onPullRequest?: (
			pull: NonNullable<TurnPublication["pullRequest"]>,
		) => unknown,
	) => Promise<PublishedTurn>;
};

/** Where the turn's publish landed, or why its committed changes were not pushed. */
export type PublishedTurn = {
	readonly publication?: TurnPublication;
	/** Why the committed changes were not pushed, in words the person can act on. */
	readonly failure?: string;
};

/**
 * Commits the turn and hands off its draft in one go (commitSessionTurn,
 * then its publish).
 */
export async function commitCompletedSessionTurn(
	session: AgentSessionRecord,
	items: readonly SessionItem[],
	runtime?: TurnGitRuntime,
	signal?: AbortSignal,
): Promise<TurnCommitOutcome | undefined> {
	const committed = await commitSessionTurn(session, items, runtime, signal);
	if (!committed) return;
	if (!committed.publish)
		return committed.notice ? { notice: committed.notice } : {};
	const { publication, failure } = await committed.publish();
	signal?.throwIfAborted();
	const notice =
		failure && committed.notice
			? `${failure} ${committed.notice}`
			: (failure ?? committed.notice);
	return {
		...(publication ? { publication } : {}),
		...(notice ? { notice } : {}),
	};
}

/**
 * Commits a root chat's turn in its checkout before completed status and
 * task review events become visible; the push and the pull request are left
 * to the returned `publish`, so the turn can show as done first.
 */
export async function commitSessionTurn(
	session: AgentSessionRecord,
	items: readonly SessionItem[],
	runtime?: TurnGitRuntime,
	signal?: AbortSignal,
): Promise<CommittedTurn | undefined> {
	if (turnPublicationRole(session) !== "chat" || !session.providerRef) return;
	return commitChatTurn(
		{ ...session, providerRef: session.providerRef },
		items,
		runtime,
		signal,
	);
}

/**
 * A root chat commits whatever its turn left in each checkout (no
 * server-owned verification gate, as before) with the managed bot identity.
 * Its publish pushes the branch and keeps its draft PR open. GitHub trouble
 * never fails the user's turn: the
 * commit stays in the chat and the chat says why it was not pushed.
 * Evaluation runs and eval users neither commit nor push.
 */
async function commitChatTurn(
	session: AgentSessionRecord & { providerRef: string },
	items: readonly SessionItem[],
	runtime?: TurnGitRuntime,
	signal?: AbortSignal,
): Promise<CommittedTurn | undefined> {
	if (await turnPublicationExcluded(session)) return;
	const project = await projectForOwner(session.userId, session.projectId);
	if (!project)
		return {
			notice:
				"Changes stay in this chat but were not committed: its project is no longer available.",
		};
	const turn = turnIdentity(session, items);
	const description = turnDescription(session, items);
	const body = turnRequestBody(items);
	const humanCoAuthor = githubAccessToken(session.userId)
		.then(githubCommitIdentityForToken)
		.catch(() => null);
	const host = runtime ?? workspaceRuntimeFromEnv();
	const repositories = await turnRepositories(
		host,
		session.providerRef,
		project,
	);
	// The agent may move the chat onto another branch; the chat follows it.
	const current = await followAgentBranch(
		session,
		host,
		repositories.find(({ repo }) => repo.fullName === project.fullName)
			?.directory,
	);
	const humanCredit = await humanCoAuthor;
	for (const { repo, directory } of repositories) {
		signal?.throwIfAborted();
		const result = await timed("commit:exec", () =>
			host.exec(
				session.providerRef,
				automaticTurnCommitArgv(
					directory,
					turn,
					[`Agent: ${description || "Update workspace"}`, body]
						.filter(Boolean)
						.join("\n\n"),
					"",
					MANAGED_GIT_BOT,
					MANAGED_GIT_BOT,
					humanCredit,
				),
				{},
				60_000,
			),
		);
		if (result.exitCode !== 0)
			return {
				notice: `Changes stay in this chat but were not committed in ${repo.fullName}: ${(result.stderr || result.stdout).trim().slice(0, 300) || "check Git status in Terminal."}`,
			};
	}
	const pending = await timed("commit:pending", () =>
		unpublishedTurnRepositories(
			host,
			session.providerRef,
			repositoriesForProject(project),
			turn,
		),
	);
	if (!pending.size) return {};
	const facts = handoffFactsFromItems(items);
	return {
		publish: async (onPullRequest) => {
			try {
				const publication = await timed("publish:handoff", () =>
					publishCompletedSessionTurn(
						current,
						host,
						turn,
						facts,
						pending,
						onPullRequest,
					),
				);
				return publication ? { publication } : {};
			} catch (error) {
				signal?.throwIfAborted();
				return { failure: await chatPublicationNotice(error) };
			}
		},
	};
}

/**
 * When the agent left the chat's checkout on a different branch than the
 * chat records, records that branch as the chat's own: the next turn's
 * checkout keeps it instead of switching back, publication pushes it, and
 * the composer shows it. The base branch (the pull request target) stays.
 * A chat without its own branch yet, a detached HEAD or an unreadable
 * checkout leaves the chat as it was.
 */
async function followAgentBranch(
	session: AgentSessionRecord & { providerRef: string },
	host: TurnGitRuntime,
	directory: string | undefined,
): Promise<AgentSessionRecord & { providerRef: string }> {
	if (!directory || !session.workingBranch || !host.readTextFile)
		return session;
	const head = await host
		.readTextFile(session.providerRef, posix.join(directory, ".git/HEAD"))
		.catch(() => null);
	const branch = branchFromGitHead(head);
	if (!branch || branch === session.workingBranch) return session;
	const saved = await saveAgentWorkingBranch(
		session.userId,
		session.id,
		branch,
	).catch(() => null);
	return saved ? { ...saved, providerRef: session.providerRef } : session;
}

/** Why a chat's committed changes were not pushed, in words the person can act on. */
export async function chatPublicationNotice(error: unknown) {
	if (error instanceof ChatPublicationSkipped) return error.message;
	if (error instanceof Response) {
		const text = (
			await error
				.clone()
				.text()
				.catch(() => "")
		).trim();
		if (/Connect GitHub|Reconnect GitHub/i.test(text))
			return `Changes are committed in this chat but were not pushed: ${text} Then send a message to push them to the chat's branch and open a draft pull request.`;
		if (error.status === 403)
			return "Changes are committed in this chat but were not pushed: ytimesy has no write access to this repository. Grant the GitHub App access (or push permission) to push the chat's branch and open a draft pull request.";
		return `Changes are committed in this chat but were not pushed: ${text || publicFailureMessage(error)}`;
	}
	return `Changes are committed in this chat but were not pushed: ${publicFailureMessage(error) || "GitHub did not accept the push."}`;
}

function turnIdentity(
	session: AgentSessionRecord,
	items: readonly SessionItem[],
) {
	const users = items.filter((item) => item.kind === "userMessage");
	const user = users.at(-1);
	return createHash("sha256")
		.update(
			JSON.stringify([
				session.id,
				users.length,
				user?.kind === "userMessage" ? user.text : null,
				user?.kind === "userMessage" ? user.timing?.startedAt : null,
			]),
		)
		.digest("hex");
}

function turnDescription(
	session: AgentSessionRecord,
	items: readonly SessionItem[],
) {
	return commitSubject(
		lastUserMessageText(items),
		session.title,
		lastAgentMessageText(items),
	);
}

/** The commit body: what was asked, so the subject can say what was done. */
function turnRequestBody(items: readonly SessionItem[]) {
	const request = (lastUserMessageText(items) ?? "").trim();
	return request ? `Request: ${request.slice(0, BODY_REQUEST_CHARS)}` : "";
}
const BODY_REQUEST_CHARS = 1000;
const SUBJECT_CHARS = 72;

/** An answer that opens with a pleasantry or an apology says nothing about the change. */
const NO_OUTCOME_OPENING =
	/^(?:yes|yep|yeah|no|ok(?:ay)?|sure|got it|done|thanks?|thank you|sorry|you(?:'|’)re right|i(?:'|’)ll|let me|here(?:'|’)s|there(?:'|’)s)\b/i;

/**
 * What the agent's final answer says it did: its first sentence, as plain
 * text, or null when the answer opens with something that is not an outcome
 * (a pleasantry, a question). Agents lead with the result, so this names the
 * change where the request often cannot ("do it", a long discussion).
 */
export function answerSubject(answer: string | null | undefined) {
	const line = (answer ?? "")
		.replace(/```[\s\S]*?```/g, " ")
		.split("\n")
		.map((text) =>
			text
				.replace(/^[#>*\-\s]+/, "")
				.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
				.replace(/[*_`]/g, "")
				.trim(),
		)
		.find(Boolean);
	if (!line) return null;
	const sentence = line
		.split(/(?<=[.!?:])\s/)[0]
		.replace(/[.:]$/, "")
		.trim();
	if (
		sentence.length < 12 ||
		sentence.endsWith("?") ||
		NO_OUTCOME_OPENING.test(sentence)
	)
		return null;
	if (sentence.length <= SUBJECT_CHARS) return sentence;
	const cut = sentence.slice(0, SUBJECT_CHARS + 1);
	return cut.slice(0, cut.lastIndexOf(" ") || SUBJECT_CHARS).trimEnd();
}

/** A reply that says nothing about the change: "Yes, do that.", "ok", "continue". */
const BARE_REPLY =
	/^(?:yes|yep|yeah|ok(?:ay)?|sure|go(?: ahead)?|do (?:it|that|this)|please|continue|proceed|sounds good|looks good|lgtm|thanks?|thank you)\b/i;

/**
 * The commit subject: what the agent's final answer says it did, else the
 * last request, unless it is a short reply to the agent ("Yes, do that."),
 * which names nothing; then the chat's title.
 */
export function commitSubject(
	message: string | null | undefined,
	title: string | null | undefined,
	answer?: string | null,
) {
	const outcome = answerSubject(answer);
	if (outcome) return outcome;
	const request = (message ?? "").replace(/\s+/g, " ").trim();
	const named = (title ?? "").replace(/\s+/g, " ").trim();
	const bare =
		!request ||
		request.split(" ").length < 4 ||
		(BARE_REPLY.test(request) && request.split(" ").length < 8);
	return (bare && named ? named : request || named).slice(0, SUBJECT_CHARS);
}

/** Each repository's checkout, under the recorded path ($HOME/<repo>) where baselines are pinned. */
async function turnRepositories(
	host: TurnGitRuntime,
	providerRef: string,
	project: Project,
) {
	const recorded = (
		await host.readTextFile?.(providerRef, PROJECT_CWD_PATH)
	)?.trim();
	const projectDirectory = recorded?.startsWith("/") ? recorded : null;
	return repositoriesForProject(project).map((repo) => ({
		repo,
		directory: !projectDirectory
			? repositoryDirectory(repo.fullName)
			: repo.fullName === project.fullName
				? projectDirectory
				: posix.join(
						posix.dirname(projectDirectory),
						projectFolderName(repo.fullName),
					),
	}));
}
