import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { z } from "zod";
import { scratchRepositoryName } from "../../../domain/add-project";
import { captureServerAnalytics } from "../../../server/adapters/analytics";
import {
	githubRepositoryCreation,
	listAuthorizedRepositories,
} from "../../../server/adapters/github";
import { requireUserAction } from "../../../server/adapters/user-action-rate";
import { requireUser } from "../../../server/auth/auth";
import { githubAccessToken } from "../../../server/auth/github-connection";
import { serverConfig } from "../../../server/config";
import { endpoint, requireSameOrigin } from "../../../server/http";
import { createScratchProject } from "../../../server/services/projects";

const scratchRepository = z.object({
	name: z.string().min(1).max(100),
});

export const Route = createFileRoute("/api/github/repositories")({
	server: {
		handlers: {
			GET: ({ request }) =>
				endpoint(async () => {
					const user = await requireUser(request.headers);
					const token = await githubAccessToken(user.id);
					const [repositories, creation] = await Promise.all([
						listAuthorizedRepositories(token),
						// The picker's "New repo" is honest about GitHub refusing it.
						githubRepositoryCreation(token).catch(() => ({
							canCreate: false,
						})),
					]);
					// Once per user per day: the picker reloads this list often.
					const now = new Date();
					void captureServerAnalytics(
						user.id,
						"repositories_listed",
						{ repositories: repositories.length },
						{ key: now.toISOString().slice(0, 10), timestamp: now },
					);
					return {
						repositories,
						installationUrl: `https://github.com/apps/${serverConfig().GITHUB_APP_SLUG}/installations/new`,
						canCreateRepository: creation.canCreate,
					};
				}),
			POST: ({ request }) =>
				endpoint(async () => {
					requireSameOrigin(request);
					const user = await requireUser(request.headers);
					await requireUserAction(user.id, "project-create");
					const name = scratchRepositoryName(
						scratchRepository.parse(await request.json()).name,
					);
					if (!name)
						throw new Response("Repository name is invalid.", { status: 400 });
					const result = await Effect.runPromise(
						Effect.result(createScratchProject(user.id, name)),
					);
					if (result._tag === "Failure") throw result.failure.cause;
					return result.success.project;
				}),
		},
	},
});
