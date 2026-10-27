import { useEffect } from "react";
import { Auth } from "#/components/auth/auth";
import { clearChatCache } from "../sessions/chat-cache";
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
	// Signed out (here or in another tab): no chat stays in the browser.
	const signedOutNow = !session.isPending && !session.data && !session.error;
	useEffect(() => {
		if (signedOutNow) void clearChatCache();
	}, [signedOutNow]);
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
