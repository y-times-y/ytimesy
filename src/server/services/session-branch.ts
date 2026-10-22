import type { Project } from "#/domain/projects";
import {
	isGeneratedSessionBranch,
	sessionBranchName,
} from "#/domain/session-branch";
import { sessionItemsFromUnknown } from "#/domain/session-item";
import {
	type AgentSessionRecord,
	agentSessionForOwner,
	projectBranchHeldByOtherSession,
	saveSessionWorkingBranch,
} from "#/server/adapters/agent-sessions";
import {
	authorizedRepository,
	repositoryBranchSha,
} from "#/server/adapters/github";
import { projectForOwner } from "#/server/adapters/projects";
import { githubAccessToken } from "#/server/auth/github-connection";

/** Called at submission, never by the picker or a background chat read. */
export async function commitChatBranchForSubmission(input: {
	userId: string;
	projectId: string;
	sessionId: string;
	text: string;
	/** The chat as the caller just read it (by id, for this user), saving a read. */
	session?: AgentSessionRecord | null;
}) {
	const session =
		input.session !== undefined && input.session?.id === input.sessionId
			? input.session
			: await agentSessionForOwner(input.userId, input.sessionId);
	if (!session || session.projectId !== input.projectId)
		throw new Error("This chat is not available.");
	if (session.parentSessionId) return session;
	if (session.turnStatus === "running")
		throw new Error("Finish the active turn before submitting another task.");
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
	const project = await projectForOwner(input.userId, input.projectId);
	if (!project) throw new Error("This project is not available.");
	// Existing chats keep their checkout; only a genuinely new task gets a generated branch.
	const hasConversation = sessionItemsFromUnknown(session.items).some(
		(item) => item.kind === "userMessage",
	);
	if (hasConversation && !session.selectedBranch) return session;
	const token = await githubAccessToken(input.userId);
	const repository = await authorizedRepository(
		token,
		project.installationId,
		project.repositoryId,
	);
	const selected =
		session.selectedBranch ?? projectBaseBranch(project, repository);
	const branch = hasConversation
		? selected
		: await availableChatBranchName({
				userId: input.userId,
				projectId: input.projectId,
				sessionId: session.id,
				title: input.text,
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
	const branch = project.branch?.trim();
	return branch && !isGeneratedSessionBranch(branch)
		? branch
		: repository.defaultBranch;
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
