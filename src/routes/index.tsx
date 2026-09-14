import { createFileRoute } from "@tanstack/react-router";
import { IdentityGate } from "../features/auth/identity-gate";
import { getCodexSession } from "../features/sessions/codex-session.fn";
import { WorkspaceHome } from "../features/workspace/workspace-home";

export const Route = createFileRoute("/")({
	loader: () => getCodexSession(),
	component: HomePage,
});

function HomePage() {
	const session = Route.useLoaderData();
	return (
		<IdentityGate>
			<WorkspaceHome initialSession={session} />
		</IdentityGate>
	);
}
