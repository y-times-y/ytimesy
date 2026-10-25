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

export const Route = createFileRoute("/")({
	loader: async () => {
		const bootstrap = await getWorkspaceBootstrap();
		// Navigating here in the browser: the page shows with its latest chat
		// open, not first without it. Only the server's page streams it in.
		if (
			typeof window !== "undefined" &&
			bootstrap.latestChatView instanceof Promise
		)
			return { ...bootstrap, latestChatView: await bootstrap.latestChatView };
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
		latestChatView,
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
			{latestChatView instanceof Promise ? (
				// A slow read of the latest chat: the page streams without it,
				// and the page with it open replaces that when the read lands.
				<Suspense fallback={home()}>
					<WithLatestChat view={latestChatView}>{home}</WithLatestChat>
				</Suspense>
			) : (
				home(latestChatView)
			)}
		</IdentityGate>
	);
}

function WithLatestChat({
	view,
	children,
}: {
	view: StreamedChatView;
	children: (openChat?: PublicCodexSession) => ReactNode;
}) {
	return children(use(view));
}
