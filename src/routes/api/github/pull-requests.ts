import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
	authorizedRepository,
	listSessionPullRequests,
} from "../../../server/adapters/github";
import { repositoryAccess } from "../../../server/adapters/github/repository-access-cache";
import { requireUser } from "../../../server/auth/auth";
import { githubAccessToken } from "../../../server/auth/github-connection";
import { endpoint } from "../../../server/http";

const selection = z.object({
	installationId: z.coerce.number().int().positive().safe(),
	repositoryId: z.coerce.number().int().positive().safe(),
});

export const Route = createFileRoute("/api/github/pull-requests")({
	server: {
		handlers: {
			GET: ({ request }) =>
				endpoint(async () => {
					const user = await requireUser(request.headers);
					const params = selection.parse(
						Object.fromEntries(new URL(request.url).searchParams),
					);
					const token = await githubAccessToken(user.id);
					// A minute's reuse of the access check (repository-access-cache.ts).
					const key = { userId: user.id, ...params };
					const repository = await repositoryAccess.access(key, () =>
						authorizedRepository(
							token,
							params.installationId,
							params.repositoryId,
						),
					);
					return {
						pullRequests: await listSessionPullRequests(
							token,
							repository.fullName,
						).catch(repositoryAccess.refused(key)),
					};
				}),
		},
	},
});
