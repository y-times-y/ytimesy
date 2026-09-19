export function authCallbackErrorMessage(error: string | undefined) {
	if (!error) return null;
	if (error === "state_mismatch")
		return "Sign-in was interrupted. Try again from this page.";
	if (error === "unable_to_link_account")
		return "That email already uses a different sign-in method.";
	return "Sign-in did not complete. Try again.";
}
