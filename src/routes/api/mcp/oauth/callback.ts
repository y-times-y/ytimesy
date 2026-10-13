import { createFileRoute } from "@tanstack/react-router";
import { takeMcpOAuthState } from "../../../../server/adapters/mcp-servers";
import { requireUser } from "../../../../server/auth/auth";
import { serverConfig } from "../../../../server/config";
import { finishMcpOAuth } from "../../../../server/services/mcp-oauth";

function redirect(target: URL) {
	return new Response(null, {
		status: 303,
		headers: {
			Location: target.toString(),
			"Cache-Control": "no-store",
			"Referrer-Policy": "no-referrer",
		},
	});
}

export const Route = createFileRoute("/api/mcp/oauth/callback")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				const appUrl = serverConfig().APP_URL;
				// The app brings the user back to where they started (see mcp-sign-in-return).
				const target = new URL("/", appUrl);
				const query = new URL(request.url).searchParams;
				try {
					const user = await requireUser(request.headers);
					const state = query.get("state");
					// The provider sends an error instead of a code when the user declines.
					const providerError = query.get("error");
					if (providerError) {
						if (state && state.length <= 256)
							await takeMcpOAuthState(user.id, state);
						target.searchParams.set(
							"mcpSignIn",
							providerError === "access_denied" ? "cancelled" : "failed",
						);
						return redirect(target);
					}
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
				return redirect(target);
			},
		},
	},
});
