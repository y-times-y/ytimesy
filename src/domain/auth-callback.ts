export function authCallbackErrorMessage(error: string | undefined) {
	if (!error) return null;
	if (error === "state_mismatch")
		return "Sign-in was interrupted. Try again from this page.";
	if (error === "unable_to_link_account" || error === "account_not_linked")
		return "That email already uses a different sign-in method. Sign in with it once that email is verified, then try GitHub again.";
	return "Sign-in did not complete. Try again.";
}
