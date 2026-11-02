import { Link } from "@tanstack/react-router";

/**
 * Shown under the buttons on sign-in and sign-up, the screens through which
 * every account is created or signs in. The server records acceptance of the
 * current versions when either happens (see accountCreated and signedIn in
 * src/server/auth/auth.ts).
 */
export function TermsNotice() {
	return (
		<p className="text-center text-xs text-muted-foreground">
			By continuing, you agree to our{" "}
			<Link to="/terms" className="underline underline-offset-4">
				Terms
			</Link>{" "}
			and{" "}
			<Link to="/privacy" className="underline underline-offset-4">
				Privacy Policy
			</Link>
			.
		</p>
	);
}
