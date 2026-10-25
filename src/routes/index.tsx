import { createFileRoute } from "@tanstack/react-router";
import { IdentityGate } from "../features/auth/identity-gate";
import { LandingPage } from "../features/landing/landing-page";
import { getWorkspaceBootstrap } from "../features/sessions/codex-session.fn";
import { WorkspaceHome } from "../features/workspace/workspace-home";

export const Route = createFileRoute("/")({
	loader: () => getWorkspaceBootstrap(),
	component: HomePage,
});

function HomePage() {
	const { session, signedIn, projects, chats, renderedAtMs } =
		Route.useLoaderData();
	return (
		<IdentityGate initialSignedIn={signedIn} signedOut={<LandingPage />}>
			<WorkspaceHome
				initialSession={session}
				initialProjects={projects}
				initialChats={chats}
				renderedAtMs={renderedAtMs}
			/>
		</IdentityGate>
	);
}
