import { z } from "zod";

const repository = z.object({
	id: z.number().int().positive(),
	full_name: z
		.string()
		.max(200)
		.regex(/^[\w.-]+\/[\w.-]+$/),
});
const sha = z.string().regex(/^[a-f0-9]{40}$/);
export const prRepairSignal = z.object({
	repositoryId: z.number().int().positive(),
	fullName: repository.shape.full_name,
	installationId: z.number().int().positive().nullable(),
	headSha: sha,
	kind: z.enum(["check_run", "check_suite", "review"]),
	sourceId: z.number().int().positive(),
	prNumber: z.number().int().positive().nullable(),
	/** Same-repository pull requests GitHub lists on a check (empty for forks). */
	prNumbers: z.array(z.number().int().positive()).max(10).default([]),
});
export type PrRepairSignal = z.infer<typeof prRepairSignal>;
/** A new comment that mentions @ytimesy on a pull request; its text is re-read later. */
export const prCommentSignal = z.object({
	repositoryId: z.number().int().positive(),
	fullName: repository.shape.full_name,
	installationId: z.number().int().positive().nullable(),
	kind: z.enum(["comment", "review_comment"]),
	sourceId: z.number().int().positive(),
	prNumber: z.number().int().positive(),
});
export type PrCommentSignal = z.infer<typeof prCommentSignal>;
export const githubPrSignal = z.union([prRepairSignal, prCommentSignal]);
export type GitHubPrSignal = PrRepairSignal | PrCommentSignal;
export const prRepairDelivery = z
	.object({
		deliveryId: z.uuid(),
		signal: githubPrSignal,
	})
	.strict();

export function isPrCommentSignal(
	signal: GitHubPrSignal,
): signal is PrCommentSignal {
	return signal.kind === "comment" || signal.kind === "review_comment";
}

/** `@ytimesy` as a whole mention (not part of an e-mail address or a longer handle). */
export const YTIMESY_MENTION = /(^|[^\w@/.-])@ytimesy(?![\w-])/i;

const pullNumbers = z
	.array(z.object({ number: z.number().int().positive() }))
	.catch([])
	.transform((pulls) => pulls.slice(0, 10).map((pull) => pull.number));

/**
 * Failed completed checks and change-requesting reviews can start repair work;
 * a human's new comment that mentions @ytimesy on a pull request can wake its
 * chat. Only bounded identifiers are kept: text is re-read from GitHub later.
 */
export function parsePrRepairSignal(
	event: string,
	raw: unknown,
): GitHubPrSignal | null {
	const common = z
		.object({
			action: z.string(),
			repository,
			installation: z.object({ id: z.number().int().positive() }).optional(),
		})
		.safeParse(raw);
	if (!common.success) return null;
	const identity = {
		repositoryId: common.data.repository.id,
		fullName: common.data.repository.full_name,
		installationId: common.data.installation?.id ?? null,
	};
	if (event === "check_run" || event === "check_suite") {
		const parsed = z
			.object({
				[event]: z.object({
					id: z.number().int().positive(),
					head_sha: sha,
					conclusion: z.string().nullable(),
					pull_requests: pullNumbers.optional(),
				}),
			})
			.safeParse(raw);
		if (!parsed.success || common.data.action !== "completed") return null;
		const check = parsed.data[event];
		if (
			!check ||
			!["failure", "timed_out", "action_required", "startup_failure"].includes(
				check.conclusion ?? "",
			)
		)
			return null;
		return {
			...identity,
			headSha: check.head_sha,
			kind: event,
			sourceId: check.id,
			prNumber: null,
			prNumbers: check.pull_requests ?? [],
		};
	}
	if (event === "issue_comment" || event === "pull_request_review_comment") {
		const author = z.object({
			type: z.string(),
		});
		const parsed = z
			.object({
				comment: z.object({
					id: z.number().int().positive(),
					body: z.string().nullable(),
					user: author,
				}),
				sender: author,
			})
			.safeParse(raw);
		const number =
			event === "issue_comment"
				? z
						.object({
							issue: z.object({
								number: z.number().int().positive(),
								pull_request: z.object({}).passthrough(),
							}),
						})
						.safeParse(raw)
				: z
						.object({
							pull_request: z.object({ number: z.number().int().positive() }),
						})
						.safeParse(raw);
		if (
			!parsed.success ||
			!number.success ||
			common.data.action !== "created" ||
			parsed.data.comment.user.type !== "User" ||
			parsed.data.sender.type !== "User" ||
			!YTIMESY_MENTION.test(parsed.data.comment.body ?? "")
		)
			return null;
		return {
			...identity,
			kind: event === "issue_comment" ? "comment" : "review_comment",
			sourceId: parsed.data.comment.id,
			prNumber:
				"issue" in number.data
					? number.data.issue.number
					: number.data.pull_request.number,
		};
	}
	if (event === "pull_request_review") {
		const parsed = z
			.object({
				review: z.object({
					id: z.number().int().positive(),
					state: z.literal("changes_requested"),
					commit_id: sha,
				}),
				pull_request: z.object({
					number: z.number().int().positive(),
					head: z.object({ sha }),
				}),
			})
			.safeParse(raw);
		if (
			!parsed.success ||
			common.data.action !== "submitted" ||
			parsed.data.review.commit_id !== parsed.data.pull_request.head.sha
		)
			return null;
		return {
			...identity,
			headSha: parsed.data.review.commit_id,
			kind: "review",
			sourceId: parsed.data.review.id,
			prNumber: parsed.data.pull_request.number,
			prNumbers: [parsed.data.pull_request.number],
		};
	}
	return null;
}
