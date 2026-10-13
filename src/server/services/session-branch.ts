import { sessionBranchName } from "#/domain/session-branch";
import { sessionItemsFromUnknown } from "#/domain/session-item";
import {
	agentSessionForOwner,
	saveSessionWorkingBranch,
} from "#/server/adapters/agent-sessions";
import { authorizedRepository } from "#/server/adapters/github";
import { projectForOwner } from "#/server/adapters/projects";
import { githubAccessToken } from "#/server/auth/github-connection";

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
