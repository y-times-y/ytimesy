import { createFileRoute } from "@tanstack/react-router";
import { IdentityGate } from "../features/auth/identity-gate";
import { getWorkspaceBootstrap } from "../features/sessions/codex-session.fn";
import { WorkspaceHome } from "../features/workspace/workspace-home";

export const Route = createFileRoute("/")({
	loader: () => getWorkspaceBootstrap(),
	component: HomePage,
});

function HomePage() {
	const { session, signedIn } = Route.useLoaderData();
	return (
		<IdentityGate initialSignedIn={signedIn}>
			<WorkspaceHome initialSession={session} />
		</IdentityGate>
	);
}
