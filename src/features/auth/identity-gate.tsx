import { Auth } from "#/components/auth/auth";
import { authClient } from "./client";
import { OnboardingShell } from "./onboarding-shell";

export function IdentityGate({ children }: { children: React.ReactNode }) {
	const session = authClient.useSession();
	if (session.isPending)
		return (
			<OnboardingShell>
				<p role="status">Loading…</p>
			</OnboardingShell>
		);
	if (session.data) return children;
	return (
		<OnboardingShell>
			<Auth view="signIn" />
		</OnboardingShell>
	);
}
