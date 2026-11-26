import { z } from "zod";

/** Sign-in funnel events carry only these enums: no email, name or message text. */
export const authFunnelView = z.enum([
	"sign_in",
	"sign_up",
	"verify_email",
	"forgot_password",
	"reset_password",
]);
export const authFunnelStep = z.enum([
	"view",
	"submit",
	"error",
	"code_sent",
	"verified",
	"retry",
]);
export const authErrorKinds = [
	"wrong_password",
	"email_not_verified",
	"already_registered",
	"weak_password",
	"invalid_code",
	"rate_limited",
	"captcha_missing",
	"captcha_failed",
	"captcha_unavailable",
	"other",
] as const;
export type AuthErrorKind = (typeof authErrorKinds)[number];

export const authFunnelEvent = z.object({
	view: authFunnelView,
	step: authFunnelStep,
	kind: z.enum(authErrorKinds).optional(),
});

type AuthError = {
	readonly code?: string;
	readonly message?: string;
	readonly status?: number;
} | null;

/** The kind of a Better Auth error response, from its code, status or message. */
export function authErrorKind(error: AuthError | undefined): AuthErrorKind {
	if (!error) return "other";
	if (error.status === 429) return "rate_limited";
	const text = `${error.code ?? ""} ${error.message ?? ""}`.toLowerCase();
	if (/missing[_ ]+(captcha|response)|missing_response/.test(text))
		return "captcha_missing";
	if (/captcha|turnstile/.test(text)) return "captcha_failed";
	if (/invalid_email_or_password|invalid_password/.test(text))
		return "wrong_password";
	if (/email_not_verified/.test(text)) return "email_not_verified";
	if (/already_exists|already_registered/.test(text))
		return "already_registered";
	if (/password_too_(short|long)/.test(text)) return "weak_password";
	if (/invalid_otp|otp_expired|too_many_attempts/.test(text))
		return "invalid_code";
	return "other";
}

/** The funnel view for an /auth/<path> page (the path never carries a token here). */
export function authViewFromPath(
	pathname: string,
): z.infer<typeof authFunnelView> {
	const view = pathname.split("/")[2] ?? "";
	if (view === "sign-up") return "sign_up";
	if (view === "verify-email") return "verify_email";
	if (view === "forgot-password") return "forgot_password";
	if (view === "reset-password") return "reset_password";
	return "sign_in";
}
