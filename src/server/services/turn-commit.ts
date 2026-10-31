import { createHash } from "node:crypto";
import { posix } from "node:path";
import { turnPublicationRole } from "#/domain/agent-task";
import { UNATTRIBUTED_COMMIT_NOTICE } from "#/domain/github-commit-identity";
import { publicFailureMessage } from "#/domain/project-workspace";
import {
	type Project,
	projectFolderName,
	repositoriesForProject,
} from "#/domain/projects";
import {
	type PublicationAuthor,
	publicationCommitAuthor,
} from "#/domain/publication";
import { handoffFactsFromItems } from "#/domain/pull-request-handoff";
import { lastUserMessageText, type SessionItem } from "#/domain/session-item";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import { PROJECT_CWD_PATH } from "../adapters/freestyle/clone-project";
import { workspaceRuntimeFromEnv } from "../adapters/freestyle/workspace-runtime";
import { githubCommitIdentityForToken } from "../adapters/github/commit-identity";
import { projectForOwner } from "../adapters/projects";
import { repositoryDirectory } from "../adapters/repository-setup";
import { automaticTurnCommitArgv } from "../adapters/turn-commit";
import { githubAccessToken } from "../auth/github-connection";
import {
	ChatPublicationSkipped,
	publishCompletedSessionTurn,
	type TurnGitRuntime,
	type TurnPublication,
	turnPublicationExcluded,
} from "./turn-publication";

/** What a root chat's turn did on GitHub, or why its changes stayed local. */
export type TurnCommitOutcome = {
	readonly publication?: TurnPublication;
	/** Shown in the chat when the changes were not committed or pushed. */
	readonly notice?: string;
};

/**
 * Commits and hands off a draft before completed status and task review
 * events become visible.
 */
export async function commitCompletedSessionTurn(
	session: AgentSessionRecord,
	items: readonly SessionItem[],
	runtime?: TurnGitRuntime,
	signal?: AbortSignal,
): Promise<TurnCommitOutcome | undefined> {
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
 * server-owned verification gate, as before), then pushes its branch and
 * keeps its draft PR open. The commit author is the user's GitHub identity
 * when that login is known; otherwise the ytimesy author is kept and the
 * chat says why. GitHub trouble never fails the user's turn: the commit
 * stays in the chat and the chat says why it was not pushed. Evaluation
 * runs and eval users neither commit nor push.
 */
async function commitChatTurn(
	session: AgentSessionRecord & { providerRef: string },
	items: readonly SessionItem[],
	runtime?: TurnGitRuntime,
	signal?: AbortSignal,
): Promise<TurnCommitOutcome | undefined> {
	if (await turnPublicationExcluded(session)) return;
	const project = await projectForOwner(session.userId, session.projectId);
	if (!project)
		return {
			notice:
				"Changes stay in this chat but were not committed: its project is no longer available.",
		};
	const turn = turnIdentity(session, items);
	const description = turnDescription(session, items);
	const authorship = await commitAuthorForUser(session.userId);
	const host = runtime ?? workspaceRuntimeFromEnv();
	for (const { repo, directory } of await turnRepositories(
		host,
		session.providerRef,
		project,
	)) {
		signal?.throwIfAborted();
		const result = await host.exec(
			session.providerRef,
			automaticTurnCommitArgv(
				directory,
				turn,
				`Agent: ${description || "Update workspace"}`,
				"",
				authorship.author,
			),
			{},
			60_000,
		);
		if (result.exitCode !== 0)
			return {
				notice: `Changes stay in this chat but were not committed in ${repo.fullName}: ${(result.stderr || result.stdout).trim().slice(0, 300) || "check Git status in Terminal."}`,
			};
	}
	try {
		const publication = await publishCompletedSessionTurn(
			session,
			host,
			turn,
			handoffFactsFromItems(items),
		);
		if (!publication)
			return authorship.unattributed ? { notice: authorship.unattributed } : {};
		return authorship.unattributed
			? { publication, notice: authorship.unattributed }
			: { publication };
	} catch (error) {
		signal?.throwIfAborted();
		const notice = await chatPublicationNotice(error);
		return {
			notice: authorship.unattributed
				? `${notice} ${authorship.unattributed}`
				: notice,
		};
	}
}

/** GitHub name and email for the commit, or the ytimesy author when the login is unknown. */
async function commitAuthorForUser(userId: string): Promise<{
	author: PublicationAuthor;
	unattributed: string | null;
}> {
	const fallback = publicationCommitAuthor({});
	try {
		const token = await githubAccessToken(userId);
		const author = await githubCommitIdentityForToken(token);
		if (author) return { author, unattributed: null };
		return { author: fallback, unattributed: UNATTRIBUTED_COMMIT_NOTICE };
	} catch (error) {
		// A missing connection is reported when the push is refused.
		if (error instanceof Response)
			return { author: fallback, unattributed: null };
		return {
			author: fallback,
			unattributed:
				"Commits use the ytimesy author because the GitHub profile could not be read.",
		};
	}
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
	return (lastUserMessageText(items) || session.title)
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 72);
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
