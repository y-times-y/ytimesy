import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import {
	type DevelopmentSessionTarget,
	developmentSessionSecretMatches,
	providedDevelopmentSessionSecret,
} from "#/domain/development-session";

/**
 * Mints a Better Auth session for the configured user. Registered only when
 * both DEV_AUTH env values are set; a missing or wrong secret 404s.
 */
export function developmentSessionPlugin(target: DevelopmentSessionTarget) {
	return {
		id: "development-session",
		endpoints: {
			developmentSession: createAuthEndpoint(
				"/development-session",
				{
					method: "GET",
					query: z.object({
						secret: z.string().optional(),
					}),
				},
				async (ctx) => {
					const provided = providedDevelopmentSessionSecret(
						ctx.query?.secret,
						ctx.request?.headers.get("x-ytimesy-dev-session") ??
							ctx.headers?.get("x-ytimesy-dev-session"),
					);
					if (!developmentSessionSecretMatches(target.secret, provided)) {
						throw hiddenDevelopmentSession();
					}
					const user = await ctx.context.internalAdapter.findUserById(
						target.userId,
					);
					if (!user) throw hiddenDevelopmentSession();
					const session = await ctx.context.internalAdapter.createSession(
						user.id,
					);
					if (!session)
						throw APIError.from("INTERNAL_SERVER_ERROR", {
							code: "INTERNAL_SERVER_ERROR",
							message: "INTERNAL_SERVER_ERROR",
						});
					await setSessionCookie(ctx, { session, user });
					throw ctx.redirect("/");
				},
			),
		},
	};
}

function hiddenDevelopmentSession() {
	return APIError.from("NOT_FOUND", {
		code: "NOT_FOUND",
		message: "NOT_FOUND",
	});
}
