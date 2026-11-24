import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionItemId } from "#/domain/ids";
import { setupProgress } from "#/domain/setup-steps";
import type { SidebarChat } from "#/domain/sidebar-chats";
import { threadDirectory } from "#/domain/thread-label";
import { RenderAsHydrated } from "#/features/app/first-paint";
import { SetupChecklistView } from "#/features/onboarding/setup-checklist";
import { ReferenceContext } from "#/features/sessions/agent-reference-chips";
import { SessionLauncher } from "#/features/sessions/session-launcher";
import { ChatHeaderTitle } from "#/features/workspace/chat-header-title";
import { ProjectSidebar } from "#/features/workspace/project-sidebar";
import { WorkspacePanes } from "#/features/workspace/workspace-panes";
import { YOverview } from "#/features/workspace/y-overview";

/**
 * The front page's and the README's picture of the app: the product's own
 * components rendered with demo data only (no real person, repository, email
 * or key). `pnpm previews` writes the result; preview-drift.test.ts fails
 * when the components change and the output was not regenerated.
 */

const NOW = Date.parse("2026-11-24T10:00:00Z");
const at = (minutesAgo: number) =>
	new Date(NOW - minutesAgo * 60_000).toISOString();

const PROJECT = {
	id: "web",
	name: "web",
	repositoryId: 1,
	installationId: 1,
	fullName: "acme/web",
	branch: "main",
};

const pr = (number: number, state: "open" | "merged") => ({
	number,
	url: `https://github.com/acme/web/pull/${number}`,
	state,
	checks: "passed" as const,
	failedChecks: 0,
});

const CHATS: SidebarChat[] = [
	{ id: "y2", title: "Y²", role: "y2", updatedAt: at(1) },
	{
		id: "t4",
		title: "Which locale for the emails?",
		threadNumber: 4,
		updatedAt: at(3),
		turnStatus: "completed",
		waitingOn: "question",
		listedModelId: "gemini-4-neon",
		workspaceId: "w4",
	},
	{
		id: "t3",
		title: "Dark mode toggle",
		threadNumber: 3,
		updatedAt: at(1),
		turnStatus: "running",
		workingSince: at(6),
		listedModelId: "gpt-6-astra",
		workspaceId: "w3",
	},
	{
		id: "t5",
		title: "Billing page",
		threadNumber: 5,
		updatedAt: at(2),
		turnStatus: "running",
		workingSince: at(14),
		listedModelId: "claude-opus-5-5",
		workspaceId: "w5",
	},
	{
		id: "t2",
		title: "Fix flaky settings test",
		threadNumber: 2,
		updatedAt: at(40),
		turnStatus: "completed",
		pr: pr(105, "open"),
		listedModelId: "gpt-6-astra",
		workspaceId: "w2",
	},
	{
		id: "t1",
		title: "Upgrade the date library",
		threadNumber: 1,
		updatedAt: at(200),
		turnStatus: "completed",
		pr: pr(104, "merged"),
		listedModelId: "claude-opus-5-5",
		workspaceId: "w1",
	},
];

const THREADS = threadDirectory(
	"web",
	CHATS.filter((chat) => chat.threadNumber).map((chat) => ({
		id: chat.id,
		title: chat.title,
		threadNumber: chat.threadNumber ?? 0,
	})),
);

const item = (id: string) => SessionItemId(id);

const CANVAS_HTML = `<body style="margin:0;background:#161616;color:#ededed;font:13px system-ui,sans-serif;padding:14px"><b>Settings, Appearance</b><p style="color:#9a9a9a;margin:6px 0 10px">Dark mode toggle, option A</p><div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border:1px solid #2c2c2c;border-radius:8px"><span>Dark mode</span><span style="width:34px;height:20px;border-radius:10px;background:#83c1ff;display:inline-block"></span></div></body>`;

const SESSION = {
	snapshotAvailable: false,
	workspaceId: "",
	agentSessionId: "y2",
	connection: {
		status: "authenticated",
		provider: "codex",
		authMode: "chatgpt",
		planType: null,
		email: null,
	},
	models: [{ id: "gpt-6-astra", label: "GPT-6 Astra" }],
	listedModelId: "gpt-6-astra",
	blockedListedModelIds: [],
	canSend: true,
	turnStatus: "completed",
	items: [
		{
			kind: "userMessage",
			id: item("u0"),
			text: "Start a dark mode toggle and a billing page. Keep me posted.",
		},
		{
			kind: "agentMessage",
			id: item("a0"),
			phase: "final_answer",
			text: "Started web-3 (dark mode toggle) and web-5 (billing page), each on its own cloud machine. I'll stay quiet until one needs you or finishes.",
		},
		{
			kind: "userMessage",
			id: item("u1"),
			text: "What's going on? @web-3 should have the toggle by now.",
		},
		{
			kind: "agentMessage",
			id: item("a1"),
			phase: "final_answer",
			text: "Two threads are working and one needs you: web-4 asks which locale the emails use. web-3 has the toggle running in its own machine, and its canvas is above.",
		},
		{
			kind: "canvas",
			id: item("c1"),
			title: "Settings, dark mode",
			revision: 1,
			html: CANVAS_HTML,
		},
	],
} as never;

const SETUP_STATE = { githubConnected: false, modelReady: false };
const noop = () => undefined;

function Chat() {
	return (
		<ReferenceContext.Provider value={{ threads: THREADS }}>
			<SessionLauncher
				session={SESSION}
				busy={false}
				harnessId="codex"
				onHarnessIdChange={noop}
				onSend={noop}
				onConnect={noop}
				onStop={noop}
				onOpenInspector={noop}
				projects={[PROJECT]}
				selectedProject={PROJECT}
				onSelectProject={noop}
				branchless
				listedTitle="Y²"
			/>
		</ReferenceContext.Provider>
	);
}

/** The signed-in app as a person with a Super agent chat open sees it. */
function App({ client }: { client: QueryClient }) {
	return (
		<QueryClientProvider client={client}>
			<div className="workspace-shell" data-preview="app">
				<RenderAsHydrated value>
					<ProjectSidebar
						projects={[PROJECT]}
						projectsLoading={false}
						selectedProjectId="web"
						selectedChatId="y2"
						onSelectProject={noop}
						expanded
						onToggle={noop}
						onAddProject={noop}
						chats={CHATS}
						onNewChat={noop}
						projectChats={[{ project: PROJECT, chats: CHATS }]}
						onOpenMemory={noop}
						renderedAtMs={NOW}
						account={{ name: "Demo user" }}
					/>
				</RenderAsHydrated>
				<main className="workspace-main">
					<WorkspacePanes
						open
						compact={false}
						ratio={0.6}
						view="overview"
						layout="chat"
						onResize={noop}
						onReset={noop}
					>
						<section className="welcome-panel" data-layout="chat">
							<div className="session-title-row">
								<div className="session-title-copy">
									<ChatHeaderTitle
										superAgent
										listedTitle="Y²"
										sessionTitle="Y²"
									/>
								</div>
							</div>
							<Chat />
						</section>
						<div className="inspector-frame">
							<YOverview
								projectId={PROJECT.id}
								projectName="web"
								pullRequests={[]}
								live={false}
								renderedAtMs={NOW}
								onOpenThread={noop}
							/>
						</div>
					</WorkspacePanes>
				</main>
			</div>
		</QueryClientProvider>
	);
}

/** A new account's first screen: the setup card above the composer. */
function FirstRun() {
	return (
		<SetupChecklistView
			progress={setupProgress({
				state: SETUP_STATE,
				repositoryCount: null,
				sessionsSkipped: false,
			})}
			state={SETUP_STATE}
			installationUrl={undefined}
			repositoriesLoading={false}
			open={null}
			onToggle={noop}
			onHide={noop}
			onModelDone={noop}
			onSessionsDone={noop}
		/>
	);
}

/** Inline scripts (first-paint choices, scroll anchors) never ship in a picture. */
const withoutScripts = (html: string) =>
	html.replace(/<script[\s\S]*?<\/script>/g, "");

export type PreviewMarkup = {
	/** The whole app with the Super agent open. */
	readonly app: string;
	/** The Overview panel alone: what needs the person, what is running. */
	readonly overview: string;
	/** A new account's setup card. */
	readonly setup: string;
};

/** The real components' markup: the whole app, and the new-user setup card. */
export function renderPreview(): PreviewMarkup {
	const client = new QueryClient();
	client.setQueryData(["agent-sessions", PROJECT.id], CHATS);
	return {
		app: withoutScripts(renderToStaticMarkup(<App client={client} />)),
		overview: withoutScripts(
			renderToStaticMarkup(
				<QueryClientProvider client={client}>
					<YOverview
						projectId={PROJECT.id}
						projectName="web"
						pullRequests={[]}
						live={false}
						renderedAtMs={NOW}
						onOpenThread={noop}
					/>
				</QueryClientProvider>,
			),
		),
		setup: withoutScripts(renderToStaticMarkup(<FirstRun />)),
	};
}
