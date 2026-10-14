import { createFileRoute } from "@tanstack/react-router";
import { requireUser } from "../../../server/auth/auth";
import {
	finishGithubConnection,
	GithubConnectionFailure,
} from "../../../server/auth/github-connection";
import { serverConfig } from "../../../server/config";
export const Route = createFileRoute("/api/github/callback")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				const target = new URL("/", serverConfig().APP_URL);
				target.searchParams.set("addProject", "1");
				const query = new URL(request.url).searchParams;
				try {
					// GitHub redirects back with error=access_denied when the user cancels.
					if (query.get("error"))
						throw new GithubConnectionFailure(
							query.get("error") === "access_denied" ? "denied" : "failed",
						);
					const user = await requireUser(request.headers);
					const state = query.get("state");
					const code = query.get("code");
					if (!state || !code || state.length > 256 || code.length > 256)
						throw new Error("Invalid callback");
					await finishGithubConnection(user.id, state, code);
				} catch (error) {
					target.searchParams.set(
						"connection",
						error instanceof GithubConnectionFailure ? error.reason : "failed",
					);
				}
				return new Response(null, {
					status: 303,
					headers: {
						Location: target.toString(),
						"Cache-Control": "no-store",
						"Referrer-Policy": "no-referrer",
					},
				});
			},
		},
	},
});
