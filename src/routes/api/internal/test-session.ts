import { createFileRoute } from "@tanstack/react-router";
import { database } from "../../../server/adapters/database";
import { serverConfig } from "../../../server/config";
import {
	mintTestSession,
	resetTestAccount,
	runTestAccountAction,
	seedTestUsage,
	TestSessionRefused,
} from "../../../server/services/test-account";

/**
 * Capability endpoint for the synthetic test account (docs/testing-live.md).
 * Takes no user id or email: the target is fixed in code. Without the
 * capability token it answers 404, like a route that does not exist.
 */
export const Route = createFileRoute("/api/internal/test-session")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const body = (await request.json().catch(() => ({}))) as {
					action?: string;
					apiKey?: unknown;
					caller?: unknown;
				};
				const token = request.headers
					.get("authorization")
					?.replace(/^Bearer\s+/i, "");
				const config = serverConfig();
				const settings = {
					expectedHash: process.env.YTIMESY_TEST_SESSION_TOKEN_SHA256,
					authSecret: config.BETTER_AUTH_SECRET,
					secureCookie: new URL(config.APP_URL).protocol === "https:",
				};
				try {
					const run =
						body.action === "reset"
							? resetTestAccount
							: body.action === "seed-usage"
								? seedTestUsage
								: mintTestSession;
					if (body.action === "seed" || body.action === "y-counts")
						return Response.json(
							await runTestAccountAction(database(), settings, token, {
								caller: body.caller,
								action: body.action,
								apiKey:
									typeof body.apiKey === "string" ? body.apiKey : undefined,
							}),
							{ headers: { "Cache-Control": "no-store" } },
						);
					return Response.json(
						await run(database(), settings, token, body.caller),
						{ headers: { "Cache-Control": "no-store" } },
					);
				} catch (error) {
					if (error instanceof TestSessionRefused) {
						const hidden =
							error.reason === "not-configured" || error.reason === "bad-token";
						return Response.json(
							{ error: hidden ? "Not found" : error.reason },
							{
								status: hidden
									? 404
									: error.reason === "rate-limited"
										? 429
										: 400,
							},
						);
					}
					console.error(
						"test-session failed",
						error instanceof Error ? error.message : error,
					);
					return Response.json({ error: "failed" }, { status: 500 });
				}
			},
		},
	},
});
