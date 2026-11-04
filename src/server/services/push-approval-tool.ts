import { type ToolSet, tool } from "ai";
import { z } from "zod";
import {
	PUSH_SUMMARY_LIMIT,
	type PushApprovalRequest,
	REQUEST_PUSH_APPROVAL_TOOL,
} from "#/domain/push-approval";
import type { gitPushRequests } from "../adapters/git-push-requests";

/** A shown card ends the turn; the user answers Push or Cancel in the chat. */
export const PUSH_APPROVAL_END_TURN_TOOLS = [
	REQUEST_PUSH_APPROVAL_TOOL,
] as const;

const repository =
	/^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/;

/**
 * Asks the user to approve the push to a default branch the git proxy just
 * refused. The card names that exact push (recorded by the proxy), so the
 * approval covers those commits only; more commits need another approval.
 */
export function pushApprovalTools(input: {
	userId: string;
	projectId: string;
	requests: Pick<typeof gitPushRequests, "latestRefused">;
	/** Commits `newId` adds over `oldId` in the workspace; null when it cannot tell. */
	countCommits(oldId: string, newId: string): Promise<number | null>;
}): ToolSet {
	return {
		[REQUEST_PUSH_APPROVAL_TOOL]: tool({
			description:
				"Ask the user to approve a push to the repository's default branch (e.g. main) after git refused it for needing approval. Work on your own branch first; ask only once the work is ready. The user sees one card with Push / Cancel, and this ends your turn. When approved, push the same commit again; when cancelled, leave the work on its branch or pull request.",
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
				return { requested: true, ...request };
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
