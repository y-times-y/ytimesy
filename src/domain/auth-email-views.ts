/**
 * What an email-only auth view says when the server cannot send email:
 * one short line instead of a form that would strand the user waiting for
 * mail. GitHub and Google on Sign in still create accounts.
 */
export function emailViewUnavailableMessage(view: string): string {
	if (view === "sign-up")
		return "Email sign-up is off here. Use GitHub or Google to sign in.";
	return "Password reset by email is off here.";
}
