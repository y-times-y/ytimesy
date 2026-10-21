import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { z } from "zod";
import { scratchRepositoryName } from "../../../domain/add-project";
import { listAuthorizedRepositories } from "../../../server/adapters/github";
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
					return {
						repositories: await listAuthorizedRepositories(
							await githubAccessToken(user.id),
						),
						installationUrl: `https://github.com/apps/${serverConfig().GITHUB_APP_SLUG}/installations/new`,
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
						Effect.either(createScratchProject(user.id, name)),
					);
					if (result._tag === "Left") throw result.left.error;
					return result.right;
				}),
		},
	},
});
