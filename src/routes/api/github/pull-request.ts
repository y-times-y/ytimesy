import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
	authorizedRepository,
	listOpenPullRequests,
	markPullRequestReady,
	mergePullRequest,
	pullRequestDetail,
} from "../../../server/adapters/github";
import { repositoryAccess } from "../../../server/adapters/github/repository-access-cache";
import { requireUser } from "../../../server/auth/auth";
import { githubAccessToken } from "../../../server/auth/github-connection";
import { endpoint, requireSameOrigin } from "../../../server/http";
import { timed } from "../../../server/services/step-timing";

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

/**
 * The signed-in user's token and the repository's name. Reads reuse a
 * confirmed access for a minute (repository-access-cache.ts); changes always
 * ask GitHub again.
 */
async function repositoryFor(
	request: Request,
	params: z.infer<typeof repositorySelection>,
	{ reuseAccess }: { reuseAccess: boolean },
) {
	const user = await requireUser(request.headers);
	const token = await timed("github:token", () => githubAccessToken(user.id));
	const key = { userId: user.id, ...params };
	const check = () =>
		authorizedRepository(token, params.installationId, params.repositoryId);
	const repository = await timed("github:authorize", () =>
		reuseAccess ? repositoryAccess.access(key, check) : check(),
	);
	return {
		token,
		fullName: repository.fullName,
		/** GitHub refused the token for this repository: check again next time. */
		refused: repositoryAccess.refused(key),
	};
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
						const { token, fullName, refused } = await repositoryFor(
							request,
							params,
							{ reuseAccess: true },
						);
						return {
							pullRequests: await timed("github:list", () =>
								listOpenPullRequests(token, fullName),
							).catch(refused),
						};
					}
					const params = selection.parse(search);
					const { token, fullName, refused } = await repositoryFor(
						request,
						params,
						{ reuseAccess: true },
					);
					return timed("github:detail", () =>
						pullRequestDetail(token, fullName, params.number),
					).catch(refused);
				}),
			POST: ({ request }) =>
				endpoint(async () => {
					requireSameOrigin(request);
					const input = action.parse(await request.json());
					const { token, fullName } = await repositoryFor(request, input, {
						reuseAccess: false,
					});
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
