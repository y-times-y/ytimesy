export function authErrorMessage(
	error: { code?: string | undefined; message?: string | undefined } | null,
	fallback: string,
) {
	switch (error?.code) {
		case "EMAIL_NOT_VERIFIED":
			return "Verify your email before signing in.";
		case "INVALID_EMAIL_OR_PASSWORD":
			return "Email or password is incorrect.";
		case "USER_ALREADY_EXISTS":
		case "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL":
			return "An account with this email already exists. Sign in instead.";
		case "PASSWORD_TOO_SHORT":
			return "Use at least 8 characters.";
		case "PASSWORD_TOO_LONG":
			return "Password is too long.";
		default:
			return fallback;
	}
}

export function isUnverifiedEmailError(
	error: { code?: string | undefined } | null,
) {
	return error?.code === "EMAIL_NOT_VERIFIED";
}
