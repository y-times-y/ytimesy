import { authClient } from "./client";
import { SignInCard } from "./sign-in-card";

export function IdentityGate({ children }: { children: React.ReactNode }) {
	const session = authClient.useSession();
	if (session.isPending)
		return (
			<main className="onboarding-shell">
				<p role="status">Loading…</p>
			</main>
		);
	if (session.data) return children;
	return (
		<main className="onboarding-shell">
			<SignInCard
				sessionError={
					session.error
						? "Unable to check your session. Please refresh."
						: undefined
				}
			/>
		</main>
	);
}
