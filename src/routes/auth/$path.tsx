import { viewPaths } from "@better-auth-ui/core";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Auth } from "#/components/auth/auth";
import { authCallbackErrorMessage } from "#/domain/auth-callback";
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
	}),
	beforeLoad({ params: { path } }) {
		if (!authPaths.has(path)) throw redirect({ to: "/" });
	},
	component: AuthPage,
});

function AuthPage() {
	const { path } = Route.useParams();
	const message = authCallbackErrorMessage(Route.useSearch().error);
	const identity = useIdentityOptions();
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
					<Auth view="signIn" />
				) : (
					<Auth path={path} />
				)}
			</div>
		</OnboardingShell>
	);
}
