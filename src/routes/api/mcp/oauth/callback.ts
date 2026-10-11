import { createFileRoute } from "@tanstack/react-router";
import { requireUser } from "../../../../server/auth/auth";
import { serverConfig } from "../../../../server/config";
import { finishMcpOAuth } from "../../../../server/services/mcp-oauth";

export const Route = createFileRoute("/api/mcp/oauth/callback")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				const appUrl = serverConfig().APP_URL;
				const target = new URL("/", appUrl);
				try {
					const user = await requireUser(request.headers);
					const query = new URL(request.url).searchParams;
					const state = query.get("state");
					const code = query.get("code");
					const issuer = query.get("iss") ?? undefined;
					if (!state || !code || state.length > 256 || code.length > 2048)
						throw new Error("Invalid callback");
					await finishMcpOAuth({
						userId: user.id,
						state,
						code,
						issuer,
						appUrl,
					});
					target.searchParams.set("mcpSignIn", "ok");
				} catch {
					target.searchParams.set("mcpSignIn", "failed");
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
