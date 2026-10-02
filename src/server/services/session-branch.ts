import { sessionBranchName } from "#/domain/session-branch";
import { sessionItemsFromUnknown } from "#/domain/session-item";
import {
	agentSessionForOwner,
	saveSessionBranchSelection,
	saveSessionWorkingBranch,
} from "#/server/adapters/agent-sessions";
import { authorizedRepository, githubClient } from "#/server/adapters/github";
import { projectForOwner } from "#/server/adapters/projects";
import { githubAccessToken } from "#/server/auth/github-connection";

export async function selectChatBranch(input: {
	userId: string;
	projectId: string;
	sessionId: string;
	branch: string;
}) {
	const session = await agentSessionForOwner(input.userId, input.sessionId);
	const project = await projectForOwner(input.userId, input.projectId);
	if (
		!session ||
		!project ||
		session.projectId !== project.id ||
		session.parentSessionId
	)
		throw new Error("This chat is not available.");
	if (session.turnStatus === "running")
		throw new Error("Stop the active turn before changing branches.");
	if (
		input.branch !== session.workingBranch &&
		input.branch !== session.taskBranch
	) {
		const token = await githubAccessToken(input.userId);
		const [owner, repo] = project.fullName.split("/");
		await githubClient(token).repos.getBranch({
			owner,
			repo,
			branch: input.branch,
		});
	}
	return saveSessionBranchSelection(input.userId, session.id, input.branch);
}

/** Called at submission, never by the picker or a background chat read. */
export async function commitChatBranchForSubmission(input: {
	userId: string;
	projectId: string;
	sessionId: string;
	text: string;
}) {
	const session = await agentSessionForOwner(input.userId, input.sessionId);
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
	const selected = session.selectedBranch ?? repository.defaultBranch;
	const branch = hasConversation
		? selected
		: sessionBranchName({
				title: input.text,
				id: session.id,
			});
	return saveSessionWorkingBranch(input.userId, session.id, branch, selected);
}
