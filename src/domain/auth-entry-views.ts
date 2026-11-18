import { viewPaths } from "@better-auth-ui/core";

/**
 * Views a signed-in person has no reason to see: they lead to a session they
 * already have. Sign-out, callback, error and reset-password are not listed;
 * those must still run for a signed-in visitor.
 */
const ENTRY_VIEW_PATHS = new Set<string>([
	viewPaths.auth.signIn,
	viewPaths.auth.signUp,
	viewPaths.auth.verifyEmail,
	viewPaths.auth.forgotPassword,
	viewPaths.auth.resetLinkSent,
]);

export function isAuthEntryView(path: string) {
	return ENTRY_VIEW_PATHS.has(path);
}
