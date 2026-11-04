import { z } from "zod";
import type { SessionItem } from "./session-item";

/**
 * The git proxy refuses a workspace push to a repository's default branch
 * unless the project allows it; the refusal tells the agent to call this
 * tool, which ends the turn on a Push / Cancel card for that exact push.
 */
export const REQUEST_PUSH_APPROVAL_TOOL = "request_push_approval";

export const PUSH_SUMMARY_LIMIT = 300;

/** What the card shows and the user approves: one refused push. */
export const pushApprovalRequest = z.object({
	/** The refused push's git_push_request row. */
	requestId: z.uuid(),
	/** owner/name */
	repo: z.string().min(3).max(201),
	branch: z.string().min(1).max(255),
	/** Commits the push adds to the branch; null when the workspace could not count them. */
	commits: z.number().int().nonnegative().nullable(),
	summary: z.string().max(PUSH_SUMMARY_LIMIT),
});
export type PushApprovalRequest = z.infer<typeof pushApprovalRequest>;

/** The tool's output when it showed a card; a refused call stays a tool call. */
export function requestedPushApproval(
	output: unknown,
	failed: boolean | undefined,
): PushApprovalRequest | null {
	if (failed) return null;
	const value = output as { requested?: unknown } | null;
	if (value?.requested !== true) return null;
	const parsed = pushApprovalRequest.safeParse(output);
	return parsed.success ? parsed.data : null;
}

export function pushApprovedText(branch: string) {
	return `Approved: push to ${branch}.`;
}

export function pushCancelledText(branch: string) {
	return `Don't push to ${branch}; leave it on the branch/PR.`;
}

/** The card's question, e.g. "Push 3 commits to main on acme/app?". */
export function pushApprovalQuestion(request: PushApprovalRequest) {
	const commits =
		request.commits === null
			? "these commits"
			: `${request.commits} ${request.commits === 1 ? "commit" : "commits"}`;
	return `Push ${commits} to ${request.branch} on ${request.repo}?`;
}

/** How a push approval card was answered, from the transcript alone. */
export function pushApprovalOutcome(
	items: readonly SessionItem[],
	requestId: SessionItem["id"],
): "pending" | "approved" | "cancelled" | "answered" {
	const index = items.findIndex((item) => item.id === requestId);
	const request = items[index];
	if (index < 0 || request?.kind !== "pushApproval") return "answered";
	const reply = items
		.slice(index + 1)
		.find((item) => item.kind === "userMessage");
	if (!reply || reply.kind !== "userMessage") return "pending";
	if (reply.text === pushApprovedText(request.branch)) return "approved";
	if (reply.text === pushCancelledText(request.branch)) return "cancelled";
	return "answered";
}
