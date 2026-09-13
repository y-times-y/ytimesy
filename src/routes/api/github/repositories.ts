import { createFileRoute } from "@tanstack/react-router";
import { listAuthorizedRepositories } from "../../../server/adapters/github";
import { requireUser } from "../../../server/auth/auth";
import { githubAccessToken } from "../../../server/auth/github-connection";
import { serverConfig } from "../../../server/config";
import { endpoint } from "../../../server/http";
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
		},
	},
});
