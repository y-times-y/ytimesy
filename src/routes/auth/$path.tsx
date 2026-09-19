import { viewPaths } from "@better-auth-ui/core";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Auth } from "#/components/auth/auth";
import { authCallbackErrorMessage } from "#/domain/auth-callback";
import { OnboardingShell } from "#/features/auth/onboarding-shell";

const authPaths = new Set(Object.values(viewPaths.auth));

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
	return (
		<OnboardingShell>
			<div className="auth-page">
				{message ? <p role="alert">{message}</p> : null}
				<Auth path={path} />
			</div>
		</OnboardingShell>
	);
}
