/**
 * Cloudflare Turnstile on the email sign-up, email sign-in, password reset
 * and resend-verification endpoints (Better Auth's captcha plugin verifies the token server side
 * against siteverify). Required in production, off everywhere else so local
 * development and tests never call Cloudflare. GitHub and Google sign-in are
 * not challenged: they already require an account with that provider.
 */
export type TurnstileSettings = {
	readonly siteKey: string;
	readonly secretKey: string;
};

export const TURNSTILE_ENDPOINTS = [
	"/sign-up/email",
	"/sign-in/email",
	"/request-password-reset",
	"/send-verification-email",
	"/email-otp/send-verification-otp",
];

export function turnstileSettings(
	env: Readonly<Record<string, string | undefined>> = process.env,
): TurnstileSettings | null {
	if (env.YTIMESY_ENVIRONMENT !== "production") return null;
	const siteKey = env.TURNSTILE_SITE_KEY?.trim();
	const secretKey = env.TURNSTILE_SECRET_KEY?.trim();
	if (!siteKey || !secretKey)
		throw new Error(
			"Production sign-in requires TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY.",
		);
	return { siteKey, secretKey };
}
