import { createFileRoute } from "@tanstack/react-router";
import { getCodexSession } from "../features/sessions/codex-session.fn";
import { WorkspaceHome } from "../features/workspace/workspace-home";

export const Route = createFileRoute("/")({
	loader: () => getCodexSession(),
	component: HomePage,
});

function HomePage() {
	const session = Route.useLoaderData();
	return <WorkspaceHome initialSession={session} />;
}
