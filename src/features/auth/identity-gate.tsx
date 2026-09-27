import { Auth } from "#/components/auth/auth";
import { authClient } from "./client";
import { OnboardingShell } from "./onboarding-shell";

export function IdentityGate({
	children,
	initialSignedIn = false,
}: {
	children: React.ReactNode;
	initialSignedIn?: boolean;
}) {
	const session = authClient.useSession();
	if (session.isPending)
		return initialSignedIn ? (
			children
		) : (
			<OnboardingShell>{null}</OnboardingShell>
		);
	if (session.data) return children;
	return (
		<OnboardingShell>
			<Auth view="signIn" />
		</OnboardingShell>
	);
}
