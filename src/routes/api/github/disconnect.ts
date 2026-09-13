import { createFileRoute } from "@tanstack/react-router";
import { requireUser } from "../../../server/auth/auth";
import { disconnectGithubConnection } from "../../../server/auth/github-connection";
import { endpoint, requireSameOrigin } from "../../../server/http";

export const Route = createFileRoute("/api/github/disconnect")({
	server: {
		handlers: {
			POST: ({ request }) =>
				endpoint(async () => {
					requireSameOrigin(request);
					await disconnectGithubConnection(
						(await requireUser(request.headers)).id,
					);
					return { connected: false };
				}),
		},
	},
});
