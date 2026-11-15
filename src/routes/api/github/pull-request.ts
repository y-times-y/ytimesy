import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
	listOpenPullRequests,
	markPullRequestReady,
	mergePullRequest,
	pullRequestDetail,
} from "../../../server/adapters/github";
import {
	actionsJobLog,
	repositoryChoices,
	runPullRequestAction,
} from "../../../server/adapters/github/pull-request-actions";
import { listRepositoryPullRequests } from "../../../server/adapters/github/pull-request-list";
import { endpoint, requireSameOrigin } from "../../../server/http";
import {
	githubRepositoryFor,
	repositorySelection,
} from "../../../server/services/github-repository-request";
import { pullRequestWriteAction } from "../../../server/services/github-write-requests";
import { timed } from "../../../server/services/step-timing";

const selection = repositorySelection.extend({
	number: z.coerce.number().int().positive().safe(),
});
const positive = z.coerce.number().int().positive().safe();
const mergeActions = z.discriminatedUnion("action", [
	selection.extend({ action: z.literal("ready") }),
	selection.extend({
		action: z.literal("merge"),
		headSha: z.string().regex(/^[0-9a-f]{40}$/),
	}),
]);

/**
 * In-app work on a repository's pull requests: list, details, comments,
 * reviews, readiness, merge and the rest of what GitHub's pull request page
 * offers. Every change runs with the signed-in user's GitHub token.
 *
 * GET without a number lists the open pull requests; with `choices=1` it
 * returns the repository's labels and assignable people; with `jobId` the
 * end of that Actions job's log.
 */
export const Route = createFileRoute("/api/github/pull-request")({
	server: {
		handlers: {
			GET: ({ request }) =>
				endpoint(async () => {
					const search = Object.fromEntries(new URL(request.url).searchParams);
					const params = repositorySelection.parse(search);
					const { token, fullName, refused } = await githubRepositoryFor(
						request,
						params,
						{ reuseAccess: true },
					);
					if (search.choices)
						return timed("github:choices", () =>
							repositoryChoices(token, fullName),
						).catch(refused);
					if (search.jobId)
						return timed("github:job-log", () =>
							actionsJobLog(token, fullName, positive.parse(search.jobId)),
						).catch(refused);
					if (!search.number)
						return {
							pullRequests: await timed("github:list", () =>
								search.state
									? listRepositoryPullRequests(
											token,
											fullName,
											z
												.enum(["open", "merged", "closed", "all"])
												.parse(search.state),
										)
									: listOpenPullRequests(token, fullName),
							).catch(refused),
						};
					const { number } = selection.parse(search);
					return timed("github:detail", () =>
						pullRequestDetail(token, fullName, number),
					).catch(refused);
				}),
			POST: ({ request }) =>
				endpoint(async () => {
					requireSameOrigin(request);
					const raw = await request.json();
					const target = selection.parse(raw);
					const { token, fullName } = await githubRepositoryFor(
						request,
						target,
						{ reuseAccess: false },
					);
					const merge = mergeActions.safeParse(raw);
					if (merge.success) {
						if (merge.data.action === "ready")
							await markPullRequestReady(token, fullName, target.number);
						else
							await mergePullRequest(
								token,
								fullName,
								target.number,
								merge.data.headSha,
							);
					} else
						await runPullRequestAction(
							token,
							fullName,
							target.number,
							pullRequestWriteAction.parse(raw),
						);
					return pullRequestDetail(token, fullName, target.number);
				}),
		},
	},
});
