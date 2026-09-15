import { createFileRoute } from "@tanstack/react-router";
import { loadAgentAccount } from "../../server/auth/agent-account";
import { requireUser } from "../../server/auth/auth";
import { githubConnectionExists } from "../../server/auth/github-connection";
import { endpoint } from "../../server/http";

export const Route = createFileRoute("/api/account")({
	server: {
		handlers: {
			GET: ({ request }) =>
				endpoint(async () => {
					const user = await requireUser(request.headers);
					return {
						user: {
							id: user.id,
							name: user.name,
							email: user.email,
							image: user.image,
						},
						githubConnected: await githubConnectionExists(user.id),
						agentAccount: await loadAgentAccount(user.id),
					};
				}),
		},
	},
});
