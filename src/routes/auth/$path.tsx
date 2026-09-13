import { viewPaths } from "@better-auth-ui/core";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Auth } from "#/components/auth/auth";

const authPaths = new Set(Object.values(viewPaths.auth));

export const Route = createFileRoute("/auth/$path")({
	beforeLoad({ params: { path } }) {
		if (!authPaths.has(path)) throw redirect({ to: "/" });
	},
	component: AuthPage,
});

function AuthPage() {
	const { path } = Route.useParams();
	return (
		<main className="onboarding-shell">
			<Auth path={path} />
		</main>
	);
}
