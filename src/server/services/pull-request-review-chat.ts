import { Effect } from "effect";
import type { AgentProviderId } from "#/domain/agent-provider";
import { pullRequestReviewMessage } from "#/domain/pull-request-review";
import { chatHoldingSend } from "../adapters/agent-sessions";
import { requireUserAction } from "../adapters/user-action-rate";
import { openAgentSession } from "./agent-session-machine";
import { sendComposerMessage } from "./queued-user-messages";
import type { WorkspaceMachines } from "./workspace-machines";

/**
 * Opens a new chat titled for this pull request and sends the review there.
 * A repeated request id returns the chat that already accepted it. The open
 * chat is not an input: a title is set so an empty "New session" is not reused.
 */
export async function startPullRequestReview(
	machines: WorkspaceMachines,
	input: {
		readonly userId: string;
		readonly projectId: string;
		readonly harnessId: AgentProviderId;
		readonly modelId: string;
		readonly requestId: string;
		readonly fullName: string;
		readonly number: number;
		readonly title: string;
		readonly url: string;
	},
): Promise<{ readonly sessionId: string }> {
	const existing = await chatHoldingSend(
		input.userId,
		input.projectId,
		input.requestId,
	);
	if (existing) return { sessionId: existing };
	await requireUserAction(input.userId, "chat-send");
	const opened = await openAgentSession({
		userId: input.userId,
		projectId: input.projectId,
		harness: input.harnessId,
		title: `Review PR #${input.number}`,
	});
	const modelId = input.modelId.trim() || opened.listedModelId?.trim() || "";
	if (!modelId) throw new Error("Select a model before starting a review.");
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
				text: pullRequestReviewMessage({
					fullName: input.fullName,
					number: input.number,
					title: input.title,
					url: input.url,
				}),
				modelId,
				idempotencyKey: input.requestId,
			},
		),
	);
	if (view.connection.status === "failed")
		throw new Error(
			view.connection.message || "The chat did not accept the review.",
		);
	return { sessionId: opened.id };
}
