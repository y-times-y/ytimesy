import { z } from "zod";
import type { IssueWriteAction } from "../../domain/github-issues";
import type { PullRequestWriteAction } from "../../domain/github-write";

/** GitHub's limit for a comment or description body. */
const body = z.string().max(65_536);
const text = body.refine(
	(value) => value.trim().length > 0,
	"Write something first.",
);
const id = z.number().int().positive().safe();
const login = z.string().regex(/^[A-Za-z0-9-]{1,39}(\[bot\])?$/);
const logins = z.array(login).max(30);
const label = z.string().min(1).max(100);
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const lineComment = z.object({
	path: z.string().min(1).max(1000),
	line: id,
	side: z.enum(["LEFT", "RIGHT"]),
	body: text,
});

/** Every change the review panel can make to a pull request, as the API accepts it. */
export const pullRequestWriteAction: z.ZodType<PullRequestWriteAction> = z
	.discriminatedUnion("action", [
		z.object({ action: z.literal("comment"), body: text }),
		z.object({ action: z.literal("reply"), commentId: id, body: text }),
		z.object({
			action: z.literal("edit-comment"),
			kind: z.enum(["comment", "inline"]),
			commentId: id,
			body: text,
		}),
		z.object({
			action: z.literal("delete-comment"),
			kind: z.enum(["comment", "inline"]),
			commentId: id,
		}),
		z.object({
			action: z.literal("resolve-thread"),
			threadId: z.string().min(1).max(200),
			resolved: z.boolean(),
		}),
		z.object({
			action: z.literal("review"),
			event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
			body,
			headSha: sha,
			comments: z.array(lineComment).max(100),
		}),
		lineComment.extend({ action: z.literal("line-comment"), headSha: sha }),
		z.object({ action: z.literal("state"), state: z.enum(["open", "closed"]) }),
		z.object({
			action: z.literal("edit"),
			title: z.string().trim().min(1).max(256).optional(),
			body: body.optional(),
		}),
		z.object({ action: z.literal("reviewers"), add: logins, remove: logins }),
		z.object({ action: z.literal("labels"), labels: z.array(label).max(100) }),
		z.object({ action: z.literal("assignees"), add: logins, remove: logins }),
		z.object({
			action: z.literal("rerun"),
			target: z.union([
				z.object({ jobId: id }),
				z.object({ failedInRunId: id }),
			]),
		}),
	])
	.refine(
		(input) =>
			input.action !== "review" ||
			input.event !== "REQUEST_CHANGES" ||
			input.body.trim().length > 0,
		"Explain the changes you are requesting.",
	);

/** Every change the Issues panel can make, as the API accepts it. */
export const issueWriteAction: z.ZodType<IssueWriteAction> =
	z.discriminatedUnion("action", [
		z.object({
			action: z.literal("create"),
			title: z.string().trim().min(1).max(256),
			body,
			labels: z.array(label).max(100),
			assignees: logins,
		}),
		z.object({
			action: z.literal("edit"),
			number: id,
			title: z.string().trim().min(1).max(256).optional(),
			body: body.optional(),
		}),
		z.object({
			action: z.literal("state"),
			number: id,
			state: z.enum(["open", "closed"]),
			reason: z.enum(["completed", "not_planned"]).optional(),
		}),
		z.object({ action: z.literal("comment"), number: id, body: text }),
		z.object({
			action: z.literal("edit-comment"),
			number: id,
			commentId: id,
			body: text,
		}),
		z.object({
			action: z.literal("delete-comment"),
			number: id,
			commentId: id,
		}),
		z.object({
			action: z.literal("labels"),
			number: id,
			labels: z.array(label).max(100),
		}),
		z.object({
			action: z.literal("assignees"),
			number: id,
			add: logins,
			remove: logins,
		}),
	]);
