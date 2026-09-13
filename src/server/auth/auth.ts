import { betterAuth } from "better-auth";
import { database } from "../adapters/database";
import { persistVerificationEmail } from "../adapters/email";
import { serverConfig } from "../config";
import { authTrustedOrigins, googleOAuthConfigured } from "./providers";

export function authOptions() {
	const config = serverConfig();
	return {
		database: database(),
		baseURL: config.APP_URL,
		secret: config.BETTER_AUTH_SECRET,
		trustedOrigins: authTrustedOrigins(config.APP_URL),
		emailAndPassword: {
			enabled: true,
			requireEmailVerification: true,
			minPasswordLength: 8,
			autoSignIn: false,
		},
		emailVerification: {
			sendOnSignUp: true,
			sendOnSignIn: true,
			autoSignInAfterVerification: true,
			sendVerificationEmail: async ({
				user,
				url,
			}: {
				user: { email: string };
				url: string;
			}) => {
				await persistVerificationEmail({
					to: user.email,
					subject: "Verify your ytimesy email",
					actionUrl: url,
				});
			},
		},
		socialProviders: {
			github: {
				disableDefaultScope: true,
				scope: ["user:email"],
				clientId: config.GITHUB_OAUTH_CLIENT_ID,
				clientSecret: config.GITHUB_OAUTH_CLIENT_SECRET,
			},
			...(googleOAuthConfigured(config)
				? {
						google: {
							clientId: config.GOOGLE_CLIENT_ID,
							clientSecret: config.GOOGLE_CLIENT_SECRET,
						},
					}
				: {}),
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
