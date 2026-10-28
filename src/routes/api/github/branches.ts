import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
	isGeneratedSessionBranch,
	orderedBaseBranches,
} from "../../../domain/session-branch";
import {
	authorizedRepository,
	listBranches,
} from "../../../server/adapters/github";
import { requireUser } from "../../../server/auth/auth";
import { githubAccessToken } from "../../../server/auth/github-connection";
import { endpoint } from "../../../server/http";

const selection = z.object({
	installationId: z.coerce.number().int().positive().safe(),
	repositoryId: z.coerce.number().int().positive().safe(),
});

/**
 * The branches a new chat can start from: the repository default first,
 * without other chats' own `ytimesy/` branches.
 */
export const Route = createFileRoute("/api/github/branches")({
	server: {
		handlers: {
			GET: ({ request }) =>
				endpoint(async () => {
					const user = await requireUser(request.headers);
					const params = selection.parse(
						Object.fromEntries(new URL(request.url).searchParams),
					);
					const token = await githubAccessToken(user.id);
					const repository = await authorizedRepository(
						token,
						params.installationId,
						params.repositoryId,
					);
					const listed = await listBranches(token, repository);
					return {
						branches: orderedBaseBranches(
							listed.names.filter((name) => !isGeneratedSessionBranch(name)),
							repository.defaultBranch,
						),
						defaultBranch: repository.defaultBranch,
						truncated: listed.truncated,
					};
				}),
		},
	},
});
