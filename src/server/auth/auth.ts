import { betterAuth } from "better-auth";
import { captcha, emailOTP } from "better-auth/plugins";
import {
	type FirstTouch,
	initialAttributionProperties,
	isBotUserAgent,
	readFirstTouchCookie,
} from "#/domain/referral-attribution";
import { captureServerAnalytics } from "../adapters/analytics";
import { database } from "../adapters/database";
import {
	authEmailDeliveryConfigured,
	persistAuthEmail,
} from "../adapters/email";
import { trackInvocationTask } from "../adapters/invocation-tasks";
import {
	recordLegalAcceptance,
	recordLegalAcceptanceAtSignIn,
} from "../adapters/legal-acceptance";
import { recordUserAttribution } from "../adapters/user-attribution";
import { serverConfig } from "../config";
import {
	loadLocalQaUser,
	requestAllowsLocalQaIdentity,
} from "./local-qa-identity";
import { authTrustedOrigins, googleOAuthConfigured } from "./providers";
import {
	cachedSession,
	forgetSession,
	forgetUserSessions,
	rememberSession,
	sessionCacheKey,
} from "./session-cache";
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
	// GitHub or Google may sign into an email account with the same address.
	// Both sides must already have verified that email. Providers are not
	// trusted blindly, so an unverified address cannot take the account over.
	accountLinking: { enabled: true, requireLocalEmailVerified: true },
	storeStateStrategy: "database" as const,
};

/**
 * Runs once an account exists (after Better Auth commits it). Every path that
 * creates an account goes through the sign-in or sign-up screen, which states
 * under its buttons that continuing accepts the Terms and Privacy Policy. A
 * failed write is logged, not thrown: the user then sees the "We updated our
 * Terms" notice on their next visit instead of a broken sign-up.
 */
export async function accountCreated(
	user: { id: string; createdAt: Date },
	context?: SignUpRequestContext | null,
) {
	await recordLegalAcceptance(user.id, "signup").catch((error: unknown) => {
		console.error("Could not record Terms acceptance at sign-up.", {
			userId: user.id,
			error: error instanceof Error ? error.message : String(error),
		});
	});
	const touch = signUpFirstTouch(context);
	if (touch)
		await recordUserAttribution(user.id, touch).catch((error: unknown) => {
			console.error("Could not record sign-up attribution.", {
				userId: user.id,
				error: error instanceof Error ? error.message : String(error),
			});
		});
	const initial = initialAttributionProperties(touch);
	void captureServerAnalytics(user.id, "account_created", initial, {
		key: user.id,
		timestamp: user.createdAt,
		setOnce: initial,
	});
}

/** The parts of Better Auth's endpoint context a sign-up hook reads. */
type SignUpRequestContext = {
	readonly headers?: Headers;
	readonly request?: Request;
};

/**
 * The visitor's first touch (the yt_first_touch cookie the browser set) on
 * the request that created the account: the email sign-up POST or the GitHub
 * or Google callback. Null for bots or when the cookie is absent.
 */
export function signUpFirstTouch(
	context: SignUpRequestContext | null | undefined,
): FirstTouch | null {
	const headers = context?.headers ?? context?.request?.headers;
	if (!headers || isBotUserAgent(headers.get("user-agent"))) return null;
	return readFirstTouchCookie(headers.get("cookie"));
}

/**
 * Runs when a session is created: every sign-in happens on the sign-in or
 * sign-up screen and its notice, so an account that accepted older versions
 * (or none) is recorded as accepting the current ones. A failed write is
 * logged, not thrown; the in-app notice then asks again.
 */
export async function signedIn(session: { userId: string }) {
	await recordLegalAcceptanceAtSignIn(session.userId).catch(
		(error: unknown) => {
			console.error("Could not record Terms acceptance at sign-in.", {
				userId: session.userId,
				error: error instanceof Error ? error.message : String(error),
			});
		},
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

/** The part of a Better Auth instance a sign-up for an existing address uses. */
export type CodeSender = {
	readonly api: {
		sendVerificationOTP(input: {
			body: { email: string; type: "email-verification" };
		}): Promise<unknown>;
	};
};

/**
 * What a sign-up with an address that already has an account sends.
 *
 * Better Auth answers such a sign-up exactly like a new one (same shape, a
 * hashed password for equal timing, no token) so the page cannot be used to
 * find out who has an account, and calls this instead of sending anything.
 * Without it nothing was sent, while the page still said "enter your code".
 *
 * - An address that never finished verifying gets a fresh code, as a new
 *   sign-up would: the person typing it is the one who can read the mail.
 * - A verified account gets a short "you already have an account" message
 *   with a link to sign in, readable only by the address's owner.
 *
 * Better Auth starts this the way it starts a new sign-up's code, in the
 * background or awaited, so the response takes as long either way. The work
 * is awaited in here, not detached: a code written after the request's
 * database context ended was emailed but never stored, so it never worked.
 * A failed send is logged; the outbox retries what it holds.
 */
export function existingAddressSignUp(
	appUrl: string,
	codeSender: () => CodeSender | undefined,
) {
	return async ({
		user,
	}: {
		user: { email: string; emailVerified?: boolean };
	}) => {
		const send = user.emailVerified
			? persistAuthEmail({
					to: user.email,
					subject: "You already have a ytimesy account",
					purpose: "account-exists",
					actionUrl: new URL("/auth/sign-in", appUrl).toString(),
					// One message per address in ten minutes, however often it is tried.
					skipIfQueuedWithinMs: 10 * 60_000,
				})
			: Promise.resolve(
					codeSender()?.api.sendVerificationOTP({
						body: { email: user.email, type: "email-verification" },
					}),
				);
		await trackInvocationTask(send).catch((error: unknown) => {
			console.warn("Could not send the existing-address sign-up email.", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
	};
}

export function authOptions(
	codeSender: () => CodeSender | undefined = () => undefined,
) {
	const config = serverConfig();
	return {
		plugins: [
			...authCaptchaPlugins(config.APP_URL),
			// Email is verified with a six-digit code typed into the app, not a
			// link: the person never leaves the page and no mail client is opened.
			emailOTP({
				otpLength: 6,
				expiresIn: 10 * 60,
				allowedAttempts: 5,
				overrideDefaultEmailVerification: true,
				async sendVerificationOTP({
					email,
					otp,
					type,
				}: {
					email: string;
					otp: string;
					type: string;
				}) {
					// Only email verification is enabled; other kinds never send.
					if (type !== "email-verification") return;
					await persistAuthEmail({
						to: email,
						subject: `${otp} is your ytimesy code`,
						purpose: "verify-email",
						actionUrl: otp,
					});
				},
			}),
		],
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
			onExistingUserSignUp: existingAddressSignUp(config.APP_URL, codeSender),
			// A reset password ends every other session, including a thief's.
			revokeSessionsOnPasswordReset: true,
			sendResetPassword: async ({
				user,
				url,
			}: {
				user: { email: string };
				url: string;
			}) => {
				// Not awaited: the response must take the same time whether or not
				// the account exists. The outbox row is retried by the cron.
				void trackInvocationTask(
					persistAuthEmail({
						to: user.email,
						subject: "Reset your ytimesy password",
						purpose: "reset-password",
						actionUrl: url,
					}),
				).catch(() => undefined);
			},
		},
		emailVerification: {
			sendOnSignUp: true,
			sendOnSignIn: true,
			// Entering the emailed code proves the address, and an account
			// cannot sign in before then, so the code signs the person in. It
			// is single-use, short-lived and limited to a few attempts. Links
			// sent before the code flow still work and sign in the same way.
			autoSignInAfterVerification: true,
			// No sendVerificationEmail here: the email-otp plugin supplies it
			// (overrideDefaultEmailVerification) and sends the code. Defining
			// one here wins over the plugin and sends a link again.
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
				// Cached sessions carry the user; a change or deletion re-reads it.
				update: {
					after: async (user: { id: string }) => forgetUserSessions(user.id),
				},
				delete: {
					after: async (user: { id: string }) => forgetUserSessions(user.id),
				},
			},
			// Sign-out, revocation and password reset delete session rows.
			session: {
				create: { after: signedIn },
				delete: {
					after: async (session: { token: string }) =>
						forgetSession(session.token),
				},
			},
		},
		session: { modelName: "auth_session", expiresIn: 60 * 60 * 24 * 7 },
		account: { modelName: "auth_account", ...oauthAccountPolicy },
		onAPIError: {
			errorURL: `${config.APP_URL}/auth/sign-in`,
		},
		verification: { modelName: "auth_verification" },
		advanced: {
			// Cloudflare sets cf-connecting-ip to the visitor's address and clients
			// cannot spoof it; rate limits are per visitor rather than one shared bucket.
			ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
			// Better Auth checks the tables once per instance, and on Workers each
			// request has its own (see auth()): two introspection queries, about
			// 150 ms, before every signed-in request. Migrations own the schema;
			// the Node server still checks it once.
			database: {
				validateSchema: process.env.YTIMESY_DATABASE_VIA_HYPERDRIVE !== "1",
			},
		},
		rateLimit: {
			enabled: true,
			storage: "database" as const,
			modelName: "auth_rate_limit",
		},
	};
}
function createAuth() {
	// The hook for an existing address sends a code through the instance
	// itself, which does not exist yet while its options are built.
	let instance: CodeSender | undefined;
	const created = betterAuth(authOptions(() => instance));
	instance = created as unknown as CodeSender;
	return created;
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
type AuthSession = NonNullable<
	Awaited<ReturnType<ReturnType<typeof createAuth>["api"]["getSession"]>>
>;

/**
 * The caller's session, or null when signed out. A cookie Better Auth
 * accepted in the last SESSION_CACHE_TTL_MS is answered from this isolate's
 * memory instead of the database (see session-cache.ts for why that is safe).
 */
export async function readSession(
	headers: Headers,
): Promise<AuthSession | null> {
	const key = sessionCacheKey(headers);
	const cached = key ? cachedSession<AuthSession>(key) : undefined;
	if (cached) return cached;
	const session = await auth().api.getSession({ headers });
	if (session && key) rememberSession(key, session);
	return session;
}

export async function requireUser(headers: Headers) {
	const session = await readSession(headers);
	if (session) return session.user;
	if (!requestAllowsLocalQaIdentity(headers)) {
		throw new Response("Sign in required", { status: 401 });
	}
	const user = await loadLocalQaUser();
	if (!user) throw new Response("Sign in required", { status: 401 });
	return user;
}
