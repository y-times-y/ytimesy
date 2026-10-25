import { createFileRoute } from "@tanstack/react-router";
import { type ReactNode, Suspense, use } from "react";
import type { PublicCodexSession } from "#/server/services/codex-workspace-session";
import { IdentityGate } from "../features/auth/identity-gate";
import { LandingPage } from "../features/landing/landing-page";
import {
	getWorkspaceBootstrap,
	type StreamedChatView,
} from "../features/sessions/codex-session.fn";
import { WorkspaceHome } from "../features/workspace/workspace-home";

/** A chat link: `/?chat=<id>`, or `/?project=<id>&chat=<id>` (GitHub wake-ups). */
type ChatLink = { chat?: string; project?: string };

export const Route = createFileRoute("/")({
	// Other parameters (addProject, mcpSignIn, ...) stay as they are.
	validateSearch: (search: Record<string, unknown>): ChatLink =>
		({
			...search,
			chat: typeof search.chat === "string" ? search.chat : undefined,
			project: typeof search.project === "string" ? search.project : undefined,
		}) as ChatLink,
	loaderDeps: ({ search }) => ({ chat: search.chat, project: search.project }),
	loader: async ({ deps }) => {
		const bootstrap = await getWorkspaceBootstrap({
			data: { chatId: deps.chat, projectId: deps.project },
		});
		// Navigating here in the browser: the page shows with its chat open,
		// not first without it. Only the server's page streams it in.
		if (
			typeof window !== "undefined" &&
			bootstrap.openChatView instanceof Promise
		)
			return { ...bootstrap, openChatView: await bootstrap.openChatView };
		return bootstrap;
	},
	component: HomePage,
});

function HomePage() {
	const {
		session,
		signedIn,
		projects,
		chats,
		openChatView,
		account,
		renderedAtMs,
	} = Route.useLoaderData();
	const home = (openChat?: PublicCodexSession) => (
		<WorkspaceHome
			initialSession={session}
			initialProjects={projects}
			initialChats={chats}
			initialChatView={openChat}
			account={account}
			renderedAtMs={renderedAtMs}
		/>
	);
	return (
		<IdentityGate initialSignedIn={signedIn} signedOut={<LandingPage />}>
			{openChatView instanceof Promise ? (
				// A slow read of the chat: the page streams without it, and the
				// page with it open replaces that when the read lands.
				<Suspense fallback={home()}>
					<WithOpenChat view={openChatView}>{home}</WithOpenChat>
				</Suspense>
			) : (
				home(openChatView)
			)}
		</IdentityGate>
	);
}

function WithOpenChat({
	view,
	children,
}: {
	view: StreamedChatView;
	children: (openChat?: PublicCodexSession) => ReactNode;
}) {
	return children(use(view));
}
