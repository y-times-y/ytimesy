import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
	authorizedRepository,
	listOpenPullRequests,
	markPullRequestReady,
	mergePullRequest,
	pullRequestDetail,
} from "../../../server/adapters/github";
import { requireUser } from "../../../server/auth/auth";
import { githubAccessToken } from "../../../server/auth/github-connection";
import { endpoint, requireSameOrigin } from "../../../server/http";

const repositorySelection = z.object({
	installationId: z.coerce.number().int().positive().safe(),
	repositoryId: z.coerce.number().int().positive().safe(),
});
const selection = repositorySelection.extend({
	number: z.coerce.number().int().positive().safe(),
});
const action = z.discriminatedUnion("action", [
	selection.extend({ action: z.literal("ready") }),
	selection.extend({
		action: z.literal("merge"),
		headSha: z.string().regex(/^[0-9a-f]{40}$/),
	}),
]);

async function repositoryFor(
	request: Request,
	params: z.infer<typeof repositorySelection>,
) {
	const user = await requireUser(request.headers);
	const token = await githubAccessToken(user.id);
	const repository = await authorizedRepository(
		token,
		params.installationId,
		params.repositoryId,
	);
	return { token, fullName: repository.fullName };
}

/** In-app review of a repository's pull requests: list, details, readiness and merge. */
export const Route = createFileRoute("/api/github/pull-request")({
	server: {
		handlers: {
			GET: ({ request }) =>
				endpoint(async () => {
					const search = Object.fromEntries(new URL(request.url).searchParams);
					// Without a number: the repository's open pull requests.
					if (!search.number) {
						const params = repositorySelection.parse(search);
						const { token, fullName } = await repositoryFor(request, params);
						return {
							pullRequests: await listOpenPullRequests(token, fullName),
						};
					}
					const params = selection.parse(search);
					const { token, fullName } = await repositoryFor(request, params);
					return pullRequestDetail(token, fullName, params.number);
				}),
			POST: ({ request }) =>
				endpoint(async () => {
					requireSameOrigin(request);
					const input = action.parse(await request.json());
					const { token, fullName } = await repositoryFor(request, input);
					if (input.action === "ready")
						await markPullRequestReady(token, fullName, input.number);
					else
						await mergePullRequest(
							token,
							fullName,
							input.number,
							input.headSha,
						);
					return pullRequestDetail(token, fullName, input.number);
				}),
		},
	},
});
