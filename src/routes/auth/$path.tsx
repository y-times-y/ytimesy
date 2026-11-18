import { viewPaths } from "@better-auth-ui/core";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { Auth } from "#/components/auth/auth";
import { authCallbackErrorMessage } from "#/domain/auth-callback";
import { emailViewUnavailableMessage } from "#/domain/auth-email-views";
import { isAuthEntryView } from "#/domain/auth-entry-views";
import { safeReturnTo } from "#/domain/return-to";
import { authClient } from "#/features/auth/client";
import { useIdentityOptions } from "#/features/auth/identity-options";
import { OnboardingShell } from "#/features/auth/onboarding-shell";

const authPaths = new Set(Object.values(viewPaths.auth));
/** Views that only work when the server can send email. */
const emailOnlyPaths = new Set([
	viewPaths.auth.signUp,
	viewPaths.auth.forgotPassword,
	viewPaths.auth.resetLinkSent,
]);

export const Route = createFileRoute("/auth/$path")({
	validateSearch: (search: Record<string, unknown>) => ({
		error: typeof search.error === "string" ? search.error : undefined,
		// Where sign-in returns to; never anything but a local path.
		redirectTo:
			search.redirectTo === undefined
				? undefined
				: safeReturnTo(search.redirectTo),
	}),
	beforeLoad({ params: { path } }) {
		if (!authPaths.has(path)) throw redirect({ to: "/" });
	},
	component: AuthPage,
});

function AuthPage() {
	const { path } = Route.useParams();
	const { error, redirectTo } = Route.useSearch();
	const message = authCallbackErrorMessage(error);
	const identity = useIdentityOptions();
	const session = authClient.useSession();
	const navigate = useNavigate();
	// Signed in already (for example by the verification link): go where the
	// person was headed instead of showing them a sign-in form.
	const leaveForApp = isAuthEntryView(path) && Boolean(session.data);
	useEffect(() => {
		if (leaveForApp)
			void navigate({ href: safeReturnTo(redirectTo), replace: true });
	}, [leaveForApp, navigate, redirectTo]);
	if (leaveForApp)
		return (
			<OnboardingShell>
				<p className="auth-page-status" role="status">
					Signing you in…
				</p>
			</OnboardingShell>
		);
	// Without email delivery, sign-up and password reset would strand the user
	// waiting for mail; GitHub and Google (on sign-in) create accounts instead.
	const emailUnavailable =
		emailOnlyPaths.has(path) && identity.data?.emailDelivery !== true;
	return (
		<OnboardingShell>
			<div className="auth-page">
				{message ? <p role="alert">{message}</p> : null}
				{identity.isPending ? (
					<p className="auth-page-status" role="status">
						Loading sign-in options…
					</p>
				) : emailUnavailable ? (
					<>
						<p className="auth-page-status" role="status">
							{emailViewUnavailableMessage(path)}
						</p>
						<a className="auth-page-link" href="/auth/sign-in">
							Back to sign in
						</a>
					</>
				) : (
					<Auth path={path} />
				)}
			</div>
		</OnboardingShell>
	);
}
