import { betterAuth } from "better-auth";
import { database } from "../adapters/database";
import { serverConfig } from "../config";

export function authOptions() {
	const config = serverConfig();
	return {
		database: database(),
		baseURL: config.APP_URL,
		secret: config.BETTER_AUTH_SECRET,
		trustedOrigins: [config.APP_URL],
		socialProviders: {
			github: {
				disableDefaultScope: true,
				scope: ["user:email"],
				clientId: config.GITHUB_OAUTH_CLIENT_ID,
				clientSecret: config.GITHUB_OAUTH_CLIENT_SECRET,
			},
		},
		user: { modelName: "auth_user" },
		session: { modelName: "auth_session", expiresIn: 60 * 60 * 24 * 7 },
		account: {
			modelName: "auth_account",
			encryptOAuthTokens: true,
			accountLinking: { enabled: false },
		},
		verification: { modelName: "auth_verification" },
		rateLimit: {
			enabled: true,
			storage: "database" as const,
			modelName: "auth_rate_limit",
		},
	};
}
function createAuth() {
	return betterAuth(authOptions());
}
let instance: ReturnType<typeof createAuth> | undefined;
export function auth() {
	instance ??= createAuth();
	return instance;
}
export async function requireUser(headers: Headers) {
	const session = await auth().api.getSession({ headers });
	if (!session) throw new Response("Sign in required", { status: 401 });
	return session.user;
}
