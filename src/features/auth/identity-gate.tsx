import { Auth } from "#/components/auth/auth";
import { authClient } from "./client";
import { OnboardingShell } from "./onboarding-shell";

export function IdentityGate({
	children,
	initialSignedIn = false,
	signedOut,
}: {
	children: React.ReactNode;
	initialSignedIn?: boolean;
	/** Replaces the sign-in card for signed-out visitors (the landing page). */
	signedOut?: React.ReactNode;
}) {
	const session = authClient.useSession();
	if (session.isPending)
		return initialSignedIn
			? children
			: (signedOut ?? <OnboardingShell>{null}</OnboardingShell>);
	if (session.data) return children;
	if (signedOut) return signedOut;
	return (
		<OnboardingShell>
			<Auth view="signIn" />
		</OnboardingShell>
	);
}
