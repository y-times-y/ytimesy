import { Effect } from "effect";
import type { AgentProviderId } from "#/domain/agent-provider";
import { issueChatMessage } from "#/domain/github-issues";
import { repositoriesForProject } from "#/domain/projects";
import { pullRequestReviewMessage } from "#/domain/pull-request-review";
import { chatHoldingSend } from "../adapters/agent-sessions";
import { authorizedRepository } from "../adapters/github";
import { projectForOwner } from "../adapters/projects";
import { requireUserAction } from "../adapters/user-action-rate";
import { githubAccessToken } from "../auth/github-connection";
import { openAgentSession } from "./agent-session-machine";
import { resolveLinkedChatRoute } from "./linked-chat-route";
import { sendComposerMessage } from "./queued-user-messages";
import type { WorkspaceMachines } from "./workspace-machines";

type LinkedChatStart = {
	readonly userId: string;
	readonly projectId: string;
	readonly harnessId: AgentProviderId;
	readonly modelId: string;
	readonly requestId: string;
	readonly fullName: string;
	readonly number: number;
	readonly title: string;
	readonly url: string;
};

/**
 * Opens a new chat titled for a GitHub item and sends its first message
 * there. A repeated request id returns the chat that already accepted it. The
 * open chat is not an input: a title is set so an empty "New session" is not
 * reused.
 */
async function startLinkedChat(
	machines: WorkspaceMachines,
	input: LinkedChatStart,
	chat: { readonly title: string; readonly message: string },
): Promise<{ readonly sessionId: string }> {
	const project = await projectForOwner(input.userId, input.projectId);
	const repository =
		project &&
		repositoriesForProject(project).find(
			(repo) => repo.fullName.toLowerCase() === input.fullName.toLowerCase(),
		);
	if (!repository) throw new Error("This repository is not in your project.");
	const token = await githubAccessToken(input.userId);
	await authorizedRepository(
		token,
		repository.installationId,
		repository.repositoryId,
	);
	const existing = await chatHoldingSend(
		input.userId,
		input.projectId,
		input.requestId,
	);
	if (existing) return { sessionId: existing };
	// The composer's choice, kept only when connected; before any chat opens.
	const route = await resolveLinkedChatRoute(input);
	await requireUserAction(input.userId, "chat-send");
	const opened = await openAgentSession({
		userId: input.userId,
		projectId: input.projectId,
		harness: route.harnessId,
		title: chat.title,
	});
	const modelId = route.modelId;
	const view = await Effect.runPromise(
		sendComposerMessage(
			machines,
			{
				userId: input.userId,
				projectId: input.projectId,
				sessionId: opened.id,
				harnessId: opened.harness,
				createNew: false,
			},
			{
				text: chat.message,
				modelId,
				idempotencyKey: input.requestId,
			},
		),
	);
	if (view.connection.status === "failed")
		throw new Error(
			view.connection.message || "The chat did not accept the message.",
		);
	return { sessionId: opened.id };
}

/** A new chat that reviews this pull request. */
export function startPullRequestReview(
	machines: WorkspaceMachines,
	input: LinkedChatStart,
): Promise<{ readonly sessionId: string }> {
	return startLinkedChat(machines, input, {
		title: `Review PR #${input.number}`,
		message: pullRequestReviewMessage(input),
	});
}

/** A new chat that works on this issue and opens a pull request closing it. */
export function startIssueChat(
	machines: WorkspaceMachines,
	input: LinkedChatStart,
): Promise<{ readonly sessionId: string }> {
	return startLinkedChat(machines, input, {
		title: `Issue #${input.number}: ${input.title}`.slice(0, 120),
		message: issueChatMessage(input),
	});
}
