import { Auth } from "#/components/auth/auth";
import { authClient } from "./client";

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
			<Auth view="signIn" />
		</main>
	);
}
