import { createFileRoute } from "@tanstack/react-router";
import { requireUser } from "../../../server/auth/auth";
import { finishGithubConnection } from "../../../server/auth/github-connection";
import { serverConfig } from "../../../server/config";
export const Route = createFileRoute("/api/github/callback")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				const target = new URL("/onboarding", serverConfig().APP_URL);
				try {
					const user = await requireUser(request.headers);
					const query = new URL(request.url).searchParams;
					const state = query.get("state");
					const code = query.get("code");
					if (!state || !code || state.length > 256 || code.length > 256)
						throw new Error("Invalid callback");
					await finishGithubConnection(user.id, state, code);
				} catch {
					target.searchParams.set("connection", "failed");
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
