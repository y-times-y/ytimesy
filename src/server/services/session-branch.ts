import { ENVIRONMENT_SETUP_TITLE } from "#/domain/environment-setup";
import type { Project } from "#/domain/projects";
import { GITHUB_SEND_BLOCK_MESSAGE } from "#/domain/send-blocked";
import {
	defaultChatBaseBranch,
	isGeneratedSessionBranch,
	isValidBranchName,
	sessionBranchName,
} from "#/domain/session-branch";
import {
	sessionItemsFromUnknown,
	sessionTitleFromText,
} from "#/domain/session-item";
import {
	type AgentSessionRecord,
	agentSessionMetadataForOwner,
	projectBranchHeldByOtherSession,
	saveSessionWorkingBranch,
	sessionHoldsUserMessage,
} from "#/server/adapters/agent-sessions";
import { markEnvironmentSetupChat } from "#/server/adapters/environment-setup-chats";
import {
	authorizedRepository,
	repositoryBranchSha,
} from "#/server/adapters/github";
import { projectForOwner } from "#/server/adapters/projects";
import { isActiveYSquaredChat } from "#/server/adapters/y-mode";
import {
	githubAccessToken,
	githubConnectionExists,
} from "#/server/auth/github-connection";

/** Called at submission, never by the picker or a background chat read. */
export async function commitChatBranchForSubmission(input: {
	userId: string;
	projectId: string;
	sessionId: string;
	text: string;
	/** The chat as the caller just read it (by id, for this user), saving a read. */
	session?: AgentSessionRecord | null;
	/** The branch a new chat starts from; ignored once the chat has a conversation. */
	baseBranch?: string;
	/** A project setup request: the new chat is a setup chat (never publishes). */
	environmentSetup?: boolean;
}) {
	// Without the caller's read, only the chat's row: its transcript (megabytes)
	// is asked one question below, in the database. Its `items` is then null,
	// never an empty transcript (the send treats it so: heldTranscript).
	const session =
		input.session !== undefined && input.session?.id === input.sessionId
			? input.session
			: ((await agentSessionMetadataForOwner(
					input.userId,
					input.sessionId,
				)) as AgentSessionRecord | null);
	if (!session || session.projectId !== input.projectId)
		throw new Error("This chat is not available.");
	if (session.parentSessionId) return session;
	if (session.turnStatus === "running")
		throw new Error("Finish the active turn before submitting another task.");
	if (input.environmentSetup)
		await markEnvironmentSetupChat(
			input.userId,
			session.id,
			sessionTitleFromText(input.text),
		);
	if (
		session.workingBranch &&
		(!session.selectedBranch ||
			session.selectedBranch === session.workingBranch)
	)
		return session;
	if (session.workingBranch && session.selectedBranch)
		return saveSessionWorkingBranch(
			input.userId,
			session.id,
			session.selectedBranch,
			session.selectedBranch,
		);
	// Y² changes no code, so it never takes a branch of its own.
	if (await isActiveYSquaredChat(input.userId, input.projectId, session))
		return session;
	const project = await projectForOwner(input.userId, input.projectId);
	if (!project) throw new Error("This project is not available.");
	// Existing chats keep their checkout; only a genuinely new task gets a generated branch.
	const hasConversation = Array.isArray(session.items)
		? sessionItemsFromUnknown(session.items).some(
				(item) => item.kind === "userMessage",
			)
		: await sessionHoldsUserMessage(input.userId, session.id);
	if (hasConversation && !session.selectedBranch) return session;
	const token = await githubAccessToken(input.userId).catch(
		async (cause: unknown) => {
			// Said as the composer says it (send-blocked.ts), not as the repository picker does.
			if (!(await githubConnectionExists(input.userId).catch(() => true)))
				throw new Error(GITHUB_SEND_BLOCK_MESSAGE);
			throw cause;
		},
	);
	const repository = await authorizedRepository(
		token,
		project.installationId,
		project.repositoryId,
	);
	// The branch the person picked for a new chat is its base: its own branch
	// starts there, its checkout fetches it and its pull requests target it.
	const chosen = hasConversation
		? undefined
		: await existingBaseBranch(input.baseBranch, token, repository.fullName);
	const selected =
		chosen ?? session.selectedBranch ?? projectBaseBranch(project, repository);
	const branch = hasConversation
		? selected
		: await availableChatBranchName({
				userId: input.userId,
				projectId: input.projectId,
				sessionId: session.id,
				title: input.environmentSetup ? ENVIRONMENT_SETUP_TITLE : input.text,
				token,
				fullName: repository.fullName,
			});
	return saveSessionWorkingBranch(input.userId, session.id, branch, selected);
}

/** The project's base-branch setting (its connected branch), else the repository default. */
export function projectBaseBranch(
	project: Pick<Project, "branch">,
	repository: { readonly defaultBranch: string },
) {
	return defaultChatBaseBranch({
		projectBranch: project.branch,
		defaultBranch: repository.defaultBranch,
	});
}

/**
 * A picked base branch, checked: a valid name, not another chat's own
 * branch, and present on GitHub now. No pick is undefined.
 */
async function existingBaseBranch(
	branch: string | undefined,
	token: string,
	fullName: string,
) {
	const name = branch?.trim();
	if (!name) return undefined;
	if (!isValidBranchName(name) || isGeneratedSessionBranch(name))
		throw new Error("Choose a repository branch to start from.");
	if (!(await repositoryBranchSha(token, fullName, name)))
		throw new Error(`${name} is no longer on GitHub. Choose another branch.`);
	return name;
}

const CHAT_BRANCH_ATTEMPTS = 6;

/**
 * The chat's `ytimesy/<slug>-<id>` name, with a short suffix when another
 * chat in the project holds it or the branch already exists on GitHub (it
 * cannot be this chat's: the name is chosen before its first push). A
 * failed GitHub lookup counts as free; the push itself never forces.
 */
export async function availableChatBranchName(input: {
	userId: string;
	projectId: string;
	sessionId: string;
	title: string;
	token: string;
	fullName: string;
}) {
	let name = sessionBranchName({ title: input.title, id: input.sessionId });
	for (let attempt = 0; attempt < CHAT_BRANCH_ATTEMPTS; attempt++) {
		name = sessionBranchName({
			title: input.title,
			id: input.sessionId,
			attempt,
		});
		const held = await projectBranchHeldByOtherSession(
			input.userId,
			input.projectId,
			input.sessionId,
			name,
		);
		if (held) continue;
		const remote = await repositoryBranchSha(
			input.token,
			input.fullName,
			name,
		).catch(() => null);
		if (!remote) return name;
	}
	return name;
}
