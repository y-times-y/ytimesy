import { randomUUID } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";
import { captureServerAnalytics } from "../../../server/adapters/analytics";
import { requireUser } from "../../../server/auth/auth";
import { startGithubConnection } from "../../../server/auth/github-connection";
import { endpoint, requireSameOrigin } from "../../../server/http";
export const Route = createFileRoute("/api/github/connect")({
	server: {
		handlers: {
			POST: ({ request }) =>
				endpoint(async () => {
					requireSameOrigin(request);
					const user = await requireUser(request.headers);
					const url = await startGithubConnection(user.id);
					void captureServerAnalytics(
						user.id,
						"github_connect_started",
						{},
						{ key: randomUUID(), timestamp: new Date() },
					);
					return { url };
				}),
		},
	},
});
