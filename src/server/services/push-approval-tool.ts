import { type ToolSet, tool } from "ai";
import { z } from "zod";
import {
	PUSH_APPROVAL_REQUESTED_NOTE,
	PUSH_SUMMARY_LIMIT,
	type PushApprovalRequest,
	REQUEST_PUSH_APPROVAL_TOOL,
} from "#/domain/push-approval";
import type { gitPushRequests } from "../adapters/git-push-requests";

const repository =
	/^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/;

/**
 * Asks the user to approve the push to a default branch the git proxy just
 * refused, and returns at once (it never ends the turn). The card names that
 * exact commit (recorded by the proxy); the user's Push pushes it
 * server-side, so the agent never pushes it again.
 */
export function pushApprovalTools(input: {
	userId: string;
	projectId: string;
	/** The chat that shows the card and later its notice. */
	sessionId: string;
	requests: Pick<typeof gitPushRequests, "latestRefused" | "markRequested">;
	/** Commits `newId` adds over `oldId` in the workspace; null when it cannot tell. */
	countCommits(oldId: string, newId: string): Promise<number | null>;
}): ToolSet {
	return {
		[REQUEST_PUSH_APPROVAL_TOOL]: tool({
			description:
				"Ask the user to approve a push to the repository's default branch (e.g. main) after git refused it for needing approval. The user sees a Push / Cancel card for that exact commit; Push pushes it for you, so never push it again yourself. This returns at once: keep doing any work that does not need main updated, and in your final summary say what waits for the push.",
			inputSchema: z.object({
				repo: z.string().describe("owner/name, as in the refused push."),
				branch: z
					.string()
					.min(1)
					.max(255)
					.describe("The default branch, e.g. main."),
				summary: z
					.string()
					.max(PUSH_SUMMARY_LIMIT)
					.describe("One short line the user sees: what the push brings."),
			}),
			execute: async ({ repo, branch, summary }) => {
				const match = repository.exec(repo.trim());
				if (!match)
					return { requested: false, error: "repo must be owner/name." };
				const refused = await input.requests.latestRefused({
					userId: input.userId,
					projectId: input.projectId,
					owner: match[1],
					name: match[2].replace(/\.git$/, ""),
					branch,
				});
				if (!refused)
					return {
						requested: false,
						error: `No refused push to ${branch} on ${repo} is waiting. Push first; ask only when git says the push needs the user's approval.`,
					};
				const request: PushApprovalRequest = {
					requestId: refused.id,
					repo: `${refused.owner}/${refused.name}`,
					branch: refused.branch,
					commits: await input
						.countCommits(refused.oldId, refused.newId)
						.catch(() => null),
					summary: summary.trim(),
				};
				if (
					!(await input.requests.markRequested(
						input.userId,
						refused.id,
						input.sessionId,
					))
				)
					return {
						requested: false,
						error: "That push was already asked for; its card is in the chat.",
					};
				return {
					requested: true,
					...request,
					note: PUSH_APPROVAL_REQUESTED_NOTE,
				};
			},
		}),
	};
}

/** Shell printing how many commits `newId` adds over `oldId` (all of them for a new branch). */
export function countCommitsCommand(oldId: string, newId: string) {
	const objectId = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
	if (!objectId.test(oldId) || !objectId.test(newId))
		throw new Error("Invalid commit id.");
	return /^0+$/.test(oldId)
		? `git rev-list --count ${newId}`
		: `git rev-list --count ${oldId}..${newId}`;
}
