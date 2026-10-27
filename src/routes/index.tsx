import { createFileRoute } from "@tanstack/react-router";
import { type ReactNode, Suspense, use } from "react";
import { WORKSPACE_PANES_END } from "../features/app/first-paint";
import { IdentityGate } from "../features/auth/identity-gate";
import { LandingPage } from "../features/landing/landing-page";
import {
	getWorkspaceBootstrap,
	type OpenChatView,
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
	// The page reads its data once. The app rewrites the address bar itself
	// (a handled link, a sign-in return), and the router takes each rewrite
	// as a navigation: reloading then would remount the page with another
	// chat open. A chat link is therefore not a loader dependency either.
	shouldReload: false,
	loader: async ({ location }) => {
		const link = location.search as ChatLink;
		const bootstrap = await getWorkspaceBootstrap({
			data: { chatId: link.chat, projectId: link.project },
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
	// The signed-in page's first paint waits until the chat and the right
	// panel are both parsed (WORKSPACE_PANES_END): a half-parsed page would
	// paint the chat full width, its transcript at the top, then move both.
	// Browsers without render-blocking expect links ignore it.
	head: ({ loaderData }) => ({
		links: loaderData?.signedIn
			? [
					{
						rel: "expect",
						href: `#${WORKSPACE_PANES_END}`,
						blocking: "render",
					},
				]
			: [],
	}),
	component: HomePage,
});

function HomePage() {
	const {
		session,
		signedIn,
		userId,
		projects,
		chats,
		projectChats,
		openChatView,
		openChatId,
		account,
		renderedAtMs,
		inspector,
		savedPullRequests,
	} = Route.useLoaderData();
	const home = (openChat?: OpenChatView) => (
		<WorkspaceHome
			initialSession={session}
			initialProjects={projects}
			initialChats={chats}
			initialProjectChats={projectChats}
			initialChatView={openChat}
			account={account}
			userId={userId}
			renderedAtMs={renderedAtMs}
			savedInspector={inspector}
			savedPullRequests={savedPullRequests}
		/>
	);
	return (
		<IdentityGate initialSignedIn={signedIn} signedOut={<LandingPage />}>
			{openChatView instanceof Promise ? (
				// A slow read of the chat: the page streams with the chat open
				// but its transcript still empty (title, composer, sidebar in
				// place), and the transcript fills in when the read lands.
				<Suspense
					fallback={home(
						openChatId ? { ...session, agentSessionId: openChatId } : undefined,
					)}
				>
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
	children: (openChat?: OpenChatView) => ReactNode;
}) {
	return children(use(view));
}
