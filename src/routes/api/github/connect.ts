import { createFileRoute } from "@tanstack/react-router";
import { requireUser } from "../../../server/auth/auth";
import { startGithubConnection } from "../../../server/auth/github-connection";
import { endpoint, requireSameOrigin } from "../../../server/http";
export const Route = createFileRoute("/api/github/connect")({
	server: {
		handlers: {
			POST: ({ request }) =>
				endpoint(async () => {
					requireSameOrigin(request);
					return {
						url: await startGithubConnection(
							(await requireUser(request.headers)).id,
						),
					};
				}),
		},
	},
});
