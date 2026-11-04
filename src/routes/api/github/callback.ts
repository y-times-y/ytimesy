import { randomUUID } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";
import type { GithubConnectionFailureReason } from "../../../domain/github-connection-callback";
import { captureServerAnalytics } from "../../../server/adapters/analytics";
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
				const userId = await requireUser(request.headers).then(
					(user) => user.id,
					() => undefined,
				);
				let outcome: "connected" | GithubConnectionFailureReason = "connected";
				try {
					// GitHub redirects back with error=access_denied when the user cancels.
					if (query.get("error"))
						throw new GithubConnectionFailure(
							query.get("error") === "access_denied" ? "denied" : "failed",
						);
					if (!userId) throw new Error("Not signed in");
					const state = query.get("state");
					const code = query.get("code");
					if (!state || !code || state.length > 256 || code.length > 256)
						throw new Error("Invalid callback");
					await finishGithubConnection(userId, state, code);
				} catch (error) {
					outcome =
						error instanceof GithubConnectionFailure ? error.reason : "failed";
					target.searchParams.set("connection", outcome);
				}
				if (userId)
					void captureServerAnalytics(
						userId,
						"github_connect_finished",
						{ outcome },
						{ key: randomUUID(), timestamp: new Date() },
					);
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
