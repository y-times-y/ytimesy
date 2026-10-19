import { betterAuth } from "better-auth";
import { captcha } from "better-auth/plugins";
import { captureServerAnalytics } from "../adapters/analytics";
import { database } from "../adapters/database";
import {
	authEmailDeliveryConfigured,
	persistAuthEmail,
} from "../adapters/email";
import { recordLegalAcceptance } from "../adapters/legal-acceptance";
import { serverConfig } from "../config";
import {
	loadLocalQaUser,
	requestAllowsLocalQaIdentity,
} from "./local-qa-identity";
import { authTrustedOrigins, googleOAuthConfigured } from "./providers";
import { TURNSTILE_ENDPOINTS, turnstileSettings } from "./turnstile";

/**
 * OAuth state lives in the database and is bound to the browser that started
 * the sign-in by a signed `state` cookie. The callback must present both, so a
 * callback URL captured from someone else's sign-in cannot be completed in a
 * victim's browser (login CSRF). Never set `skipStateCookieCheck`: the local
 * loopback-alias mismatch it once papered over is fixed by
 * `canonicalOriginRedirect` sending every page to the APP_URL host.
 */
export const oauthAccountPolicy = {
	encryptOAuthTokens: true,
	accountLinking: { enabled: false },
	storeStateStrategy: "database" as const,
};

/**
 * Runs once an account exists (after Better Auth commits it). Every path that
 * creates an account shows the Terms and Privacy consent first: the sign-up
 * checkbox gates the email form and the GitHub/Google buttons, and sign-in
 * (which can create an account through a provider) states that continuing
 * accepts them. A failed write is logged, not thrown: the user then gets the
 * acceptance prompt on their next visit instead of a broken sign-up.
 */
export async function accountCreated(user: { id: string; createdAt: Date }) {
	await recordLegalAcceptance(user.id, "signup").catch((error: unknown) => {
		console.error("Could not record Terms acceptance at sign-up.", {
			userId: user.id,
			error: error instanceof Error ? error.message : String(error),
		});
	});
	void captureServerAnalytics(
		user.id,
		"account_created",
		{},
		{ key: user.id, timestamp: user.createdAt },
	);
}

/** Server-side Turnstile verification, when this environment requires it. */
export function authCaptchaPlugins(appUrl: string) {
	const turnstile = turnstileSettings();
	if (!turnstile) return [];
	return [
		captcha({
			provider: "cloudflare-turnstile",
			secretKey: turnstile.secretKey,
			endpoints: TURNSTILE_ENDPOINTS,
			allowedHostnames: [new URL(appUrl).hostname],
		}),
	];
}

function authOptions() {
	const config = serverConfig();
	return {
		plugins: authCaptchaPlugins(config.APP_URL),
		database: database(),
		baseURL: config.APP_URL,
		secret: config.BETTER_AUTH_SECRET,
		trustedOrigins: authTrustedOrigins(config.APP_URL),
		emailAndPassword: {
			enabled: true,
			// Accounts that must verify an email cannot be created while no
			// email can be sent; existing accounts keep signing in.
			disableSignUp: !authEmailDeliveryConfigured(),
			requireEmailVerification: true,
			minPasswordLength: 8,
			autoSignIn: false,
			sendResetPassword: async ({
				user,
				url,
			}: {
				user: { email: string };
				url: string;
			}) => {
				await persistAuthEmail({
					to: user.email,
					subject: "Reset your ytimesy password",
					purpose: "reset-password",
					actionUrl: url,
				});
			},
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
				await persistAuthEmail({
					to: user.email,
					subject: "Verify your ytimesy email",
					purpose: "verify-email",
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
		databaseHooks: {
			user: {
				create: { after: accountCreated },
			},
		},
		session: { modelName: "auth_session", expiresIn: 60 * 60 * 24 * 7 },
		account: { modelName: "auth_account", ...oauthAccountPolicy },
		onAPIError: {
			errorURL: `${config.APP_URL}/auth/sign-in`,
		},
		verification: { modelName: "auth_verification" },
		// Cloudflare sets cf-connecting-ip to the visitor's address and clients
		// cannot spoof it; rate limits are per visitor rather than one shared bucket.
		advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
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
// One instance per database pool: on Workers each request has its own pool, and
// an instance must never hold another request's (already closed) connections.
const instances = new WeakMap<object, ReturnType<typeof createAuth>>();
export function auth() {
	const pool = database();
	let instance = instances.get(pool);
	if (!instance) {
		instance = createAuth();
		instances.set(pool, instance);
	}
	return instance;
}
export async function requireUser(headers: Headers) {
	const session = await auth().api.getSession({ headers });
	if (session) return session.user;
	if (!requestAllowsLocalQaIdentity(headers)) {
		throw new Response("Sign in required", { status: 401 });
	}
	const user = await loadLocalQaUser();
	if (!user) throw new Response("Sign in required", { status: 401 });
	return user;
}
