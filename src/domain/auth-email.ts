export type AuthEmailPurpose = "verify-email" | "reset-password";

/** Attempts before a message is given up. Links expire after an hour anyway. */
export const AUTH_EMAIL_MAX_ATTEMPTS = 6;
/** Verification and reset links stop working after Better Auth's default hour. */
export const AUTH_EMAIL_LINK_LIFETIME_MS = 60 * 60 * 1000;

/** Exponential backoff between attempts: 30s, 1m, 2m, 4m, 8m (capped at 15m). */
export function authEmailRetryDelayMs(attempts: number) {
	return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 15 * 60_000);
}

export function authEmailExpired(createdAt: Date, now: Date) {
	return now.getTime() - createdAt.getTime() > AUTH_EMAIL_LINK_LIFETIME_MS;
}

const escapeHtml = (value: string) =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");

/** A verification email carries either a link or a six-digit code. */
export const isVerificationCode = (value: string) => /^\d{6}$/.test(value);

/** Plain-text and HTML bodies for a verification or password-reset email. */
export function authEmailContent(purpose: AuthEmailPurpose, actionUrl: string) {
	if (purpose === "verify-email" && isVerificationCode(actionUrl))
		return verificationCodeContent(actionUrl);
	const copy =
		purpose === "verify-email"
			? {
					intro: "Confirm your email address to finish setting up ytimesy.",
					action: "Verify email",
					ignore: "If you didn't create a ytimesy account, ignore this email.",
				}
			: {
					intro: "Someone asked to reset your ytimesy password.",
					action: "Reset password",
					ignore:
						"If it wasn't you, ignore this email; your password stays the same.",
				};
	const expiry = "The link expires in one hour.";
	const text = `${copy.intro}\n\n${copy.action}: ${actionUrl}\n\n${expiry} ${copy.ignore}\n`;
	const url = escapeHtml(actionUrl);
	const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f6f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fff;border-radius:12px;padding:32px">
<tr><td style="font-size:18px;font-weight:600;padding-bottom:16px">ytimesy</td></tr>
<tr><td style="font-size:15px;line-height:22px;padding-bottom:24px">${escapeHtml(copy.intro)}</td></tr>
<tr><td style="padding-bottom:24px"><a href="${url}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 18px;border-radius:8px">${copy.action}</a></td></tr>
<tr><td style="font-size:13px;line-height:20px;color:#666">${expiry} ${escapeHtml(copy.ignore)}<br><br>Or open this link: <a href="${url}" style="color:#666">${url}</a></td></tr>
</table></td></tr></table></body></html>`;
	return { text, html };
}

/** The email that carries a six-digit verification code. */
function verificationCodeContent(code: string) {
	const expiry = "The code expires in 10 minutes.";
	const ignore = "If you didn't create a ytimesy account, ignore this email.";
	const text = `Your ytimesy verification code is ${code}\n\nEnter it on the verify page to finish signing in. ${expiry} ${ignore}\n`;
	const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f6f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fff;border-radius:12px;padding:32px">
<tr><td style="font-size:18px;font-weight:600;padding-bottom:16px">ytimesy</td></tr>
<tr><td style="font-size:15px;line-height:22px;padding-bottom:20px">Your verification code</td></tr>
<tr><td style="padding-bottom:24px"><div style="font-size:34px;letter-spacing:10px;font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${code}</div></td></tr>
<tr><td style="font-size:13px;line-height:20px;color:#666">Enter it on the verify page to finish signing in. ${expiry} ${ignore}</td></tr>
</table></td></tr></table></body></html>`;
	return { text, html };
}
