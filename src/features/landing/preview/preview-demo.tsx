import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { IssueSummary } from "#/domain/github-issues";
import { SessionItemId } from "#/domain/ids";
import type { RepositoryPullRequest } from "#/domain/pull-request-review";
import type { SidebarChat } from "#/domain/sidebar-chats";
import { threadDirectory } from "#/domain/thread-label";
import { RenderAsHydrated } from "#/features/app/first-paint";
import { ReferenceContext } from "#/features/sessions/agent-reference-chips";
import { SessionLauncher } from "#/features/sessions/session-launcher";
import { SideChatFrame } from "#/features/sessions/side-chat-panel";
import { ChatHeaderTitle } from "#/features/workspace/chat-header-title";
import { ProjectSidebar } from "#/features/workspace/project-sidebar";
import { WorkItemsPage } from "#/features/workspace/work-items-page";
import {
	issuesKey,
	pullRequestsKey,
} from "#/features/workspace/work-items-queries";
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
	id: "ytimesy",
	name: "ytimesy",
	repositoryId: 1,
	installationId: 1,
	fullName: "y-times-y/ytimesy",
	branch: "main",
};

const pr = (number: number, state: "open" | "merged") => ({
	number,
	url: `https://github.com/y-times-y/ytimesy/pull/${number}`,
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
		id: "t1",
		title: "Rate-limit the public API",
		threadNumber: 1,
		updatedAt: at(4),
		turnStatus: "running",
		workingSince: at(9),
		listedModelId: "gpt-6-astra",
		workspaceId: "w6",
	},
	{
		id: "t2",
		title: "Onboarding emails",
		threadNumber: 2,
		updatedAt: at(4),
		turnStatus: "running",
		workingSince: at(4),
		listedModelId: "gemini-4-neon",
		workspaceId: "w7",
	},
	{
		id: "t6",
		title: "Approve the pricing copy",
		threadNumber: 6,
		updatedAt: at(7),
		turnStatus: "completed",
		waitingOn: "plan",
		listedModelId: "claude-opus-5-5",
		workspaceId: "w9",
	},
	{
		id: "t7",
		title: "Fix flaky settings test",
		threadNumber: 7,
		updatedAt: at(40),
		turnStatus: "completed",
		pr: pr(105, "open"),
		listedModelId: "gpt-6-astra",
		workspaceId: "w2",
	},
	{
		id: "t8",
		title: "Upgrade the date library",
		threadNumber: 8,
		updatedAt: at(200),
		turnStatus: "completed",
		pr: pr(104, "merged"),
		listedModelId: "claude-opus-5-5",
		workspaceId: "w1",
	},
];

const THREADS = threadDirectory(
	"ytimesy",
	CHATS.filter((chat) => chat.threadNumber).map((chat) => ({
		id: chat.id,
		title: chat.title,
		threadNumber: chat.threadNumber ?? 0,
	})),
);

const item = (id: string) => SessionItemId(id);

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
			text: "Start a dark mode toggle, a billing page and rate limiting for the public API. Keep me posted, and only interrupt me if something needs a decision.",
		},
		{
			kind: "agentMessage",
			id: item("a0"),
			phase: "final_answer",
			text: "Started ytimesy-3 (dark mode toggle), ytimesy-5 (billing page) and ytimesy-1 (rate limiting), each on its own cloud machine. I'll stay quiet until one needs you or finishes.",
		},
		{
			kind: "userMessage",
			id: item("u1"),
			text: "Also look at the onboarding emails in @ytimesy-2. It should reuse the locale from @ytimesy-4 once I have answered, and @ytimesy-1 should not start before @ytimesy-3 has merged.",
		},
		{
			kind: "agentMessage",
			id: item("a1"),
			phase: "final_answer",
			text: "Done. I told ytimesy-2 to wait for the locale and ytimesy-1 to wait for ytimesy-3. Four threads are running in parallel.",
		},
		{
			kind: "agentMessage",
			id: item("a1b"),
			phase: "final_answer",
			text: "ytimesy-3 has the toggle and a test for it, ytimesy-5 is wiring the invoice totals, and ytimesy-7 finished its fix: the settings test no longer depends on the clock.",
		},
		{
			kind: "userMessage",
			id: item("u2"),
			text: "What's going on? @ytimesy-3 should have the toggle by now.",
		},
		{
			kind: "agentMessage",
			id: item("a2"),
			phase: "final_answer",
			text: "Two threads need you: ytimesy-4 asks which locale the emails use, and ytimesy-6 wants your approval of the pricing copy. ytimesy-3 has the toggle running in its own machine. It already has a draft you can review. ytimesy-7 finished: pull request #105 is ready to merge.",
		},
		{
			kind: "userMessage",
			id: item("u3"),
			text: "Merge #105 when its checks pass, and ask @ytimesy-2 to send me the draft before it goes out.",
		},
		{
			kind: "agentMessage",
			id: item("a3"),
			phase: "final_answer",
			text: "Queued: #105 merges as soon as its last check passes. ytimesy-2 will send you the draft of the onboarding emails first, and I'll stay quiet until then.",
		},
	],
} as never;

const noop = () => undefined;

const REPOSITORY = {
	installationId: 1,
	repositoryId: 1,
	name: "y-times-y/ytimesy",
	projectId: PROJECT.id,
};

const person = (login: string) => ({ login, avatarUrl: null, bot: false });

const label = (name: string, color: string) => ({ name, color });

/** The demo repository's pull requests: some are a thread's own (head `ytimesy-<n>`). */
const PULLS: RepositoryPullRequest[] = [
	{
		number: 106,
		title: "Dark mode toggle in settings",
		url: "https://github.com/y-times-y/ytimesy/pull/106",
		author: "demo-user",
		authorName: null,
		authorAvatarUrl: null,
		draft: false,
		state: "open",
		head: "ytimesy-3",
		base: "main",
		updatedAt: at(2),
		labels: [label("design", "7057ff")],
		review: { kind: "requested", from: person("reviewer"), you: true },
		checks: { passed: 5, failed: 0, pending: 1 },
		additions: 84,
		deletions: 12,
		waiting: true,
		closes: [41],
	},
	{
		number: 105,
		title: "Fix flaky settings test",
		url: "https://github.com/y-times-y/ytimesy/pull/105",
		author: "demo-user",
		authorName: null,
		authorAvatarUrl: null,
		draft: false,
		state: "open",
		head: "ytimesy-7",
		base: "main",
		updatedAt: at(40),
		labels: [label("tests", "0e8a16")],
		review: { kind: "approved", by: person("reviewer") },
		checks: { passed: 6, failed: 0, pending: 0 },
		additions: 18,
		deletions: 7,
		waiting: true,
	},
	{
		number: 107,
		title: "Billing page",
		url: "https://github.com/y-times-y/ytimesy/pull/107",
		author: "demo-user",
		authorName: null,
		authorAvatarUrl: null,
		draft: true,
		state: "draft",
		head: "ytimesy-5",
		base: "main",
		updatedAt: at(9),
		labels: [label("billing", "fbca04")],
		checks: { passed: 2, failed: 1, pending: 0 },
		additions: 212,
		deletions: 30,
	},
];

const ISSUES: IssueSummary[] = [
	{
		number: 41,
		title: "Add a dark mode toggle to settings",
		url: "https://github.com/y-times-y/ytimesy/issues/41",
		state: "open",
		stateReason: null,
		author: person("reviewer"),
		labels: [label("design", "7057ff")],
		assignees: [person("demo-user")],
		comments: 3,
		createdAt: at(5000),
		updatedAt: at(6),
		waiting: true,
		pullRequests: [{ number: 106, state: "open", head: "ytimesy-3" }],
	},
	{
		number: 43,
		title: "Emails should use the account's locale",
		url: "https://github.com/y-times-y/ytimesy/issues/43",
		state: "open",
		stateReason: null,
		author: person("demo-user"),
		labels: [label("bug", "d73a4a")],
		assignees: [],
		comments: 1,
		createdAt: at(3000),
		updatedAt: at(180),
	},
	{
		number: 38,
		title: "Billing page shows the wrong total",
		url: "https://github.com/y-times-y/ytimesy/issues/38",
		state: "open",
		stateReason: null,
		author: person("reviewer"),
		labels: [label("billing", "fbca04")],
		assignees: [],
		comments: 0,
		createdAt: at(9000),
		updatedAt: at(1500),
	},
];

/** The chat working on each pull request, by its head branch: the row's thread chip. */
const THREAD_BY_HEAD = new Map(
	CHATS.filter((chat) => chat.threadNumber).map((chat) => [
		`ytimesy-${chat.threadNumber}`,
		{
			id: chat.id,
			title: chat.title,
			working: chat.turnStatus === "running",
		},
	]),
);

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

export type PreviewScene = "super-agent" | "pull-requests" | "issues";

/** The signed-in app, as the real components draw it, with one scene open. */
function App({ scene }: { scene: PreviewScene }) {
	const client = new QueryClient();
	client.setQueryData(["agent-sessions", PROJECT.id], CHATS);
	client.setQueryData(pullRequestsKey(REPOSITORY.repositoryId, "open"), {
		pullRequests: PULLS.map((pull) => ({
			...pull,
			installationId: 1,
			repositoryId: 1,
			repositoryFullName: "y-times-y/ytimesy",
		})),
	});
	client.setQueryData(issuesKey(REPOSITORY.repositoryId, "open"), {
		issues: ISSUES,
	});
	const work = scene === "super-agent" ? null : scene;
	return (
		<QueryClientProvider client={client}>
			<div className="workspace-shell" data-preview={scene}>
				<RenderAsHydrated value>
					<ProjectSidebar
						projects={[PROJECT]}
						projectsLoading={false}
						selectedProjectId="ytimesy"
						selectedChatId={work ? undefined : "y2"}
						onSelectProject={noop}
						expanded
						onToggle={noop}
						onAddProject={noop}
						chats={CHATS}
						onNewChat={noop}
						projectChats={[{ project: PROJECT, chats: CHATS }]}
						onOpenMemory={noop}
						onOpenWorkItems={noop}
						workItemsActive={work}
						renderedAtMs={NOW}
						account={{ name: "Demo user" }}
					/>
				</RenderAsHydrated>
				<main
					className="workspace-main"
					data-work-page={work ? "true" : undefined}
				>
					{work ? (
						<WorkItemsPage
							kind={work}
							repositories={[REPOSITORY]}
							chatsOf={() => THREAD_BY_HEAD}
							issueChatsOf={() => new Map()}
							onOpenChat={noop}
							onChatStarted={noop}
						/>
					) : (
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
								<div className="welcome-content" data-layout="chat">
									<Chat />
								</div>
							</section>
							<div className="inspector-frame">
								<YOverview
									projectId={PROJECT.id}
									projectName="ytimesy"
									pullRequests={[]}
									live={false}
									renderedAtMs={NOW}
									onOpenThread={noop}
								/>
							</div>
						</WorkspacePanes>
					)}
				</main>
			</div>
		</QueryClientProvider>
	);
}

/** Inline scripts (first-paint choices, scroll anchors) never ship in a picture. */
const withoutScripts = (html: string) =>
	html.replace(/<script[\s\S]*?<\/script>/g, "");

export type PreviewMarkup = Readonly<Record<PreviewScene, string>>;

/** The real components' markup, one entry per scene. */
export function renderPreview(): PreviewMarkup {
	const scene = (name: PreviewScene) =>
		withoutScripts(renderToStaticMarkup(<App scene={name} />));
	return {
		"super-agent": scene("super-agent"),
		"pull-requests": scene("pull-requests"),
		issues: scene("issues"),
	};
}

/**
 * Main's chat and the side chat as the real components draw them, in a plain
 * flex split, for the composer alignment check (scripts/measure-composers.ts).
 * Not part of the pictures.
 */
export function renderSplitChat(stacked: boolean) {
	const side = (
		<SideChatFrame parentTurnStatus="completed">
			<SessionLauncher
				variant="side"
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
			/>
		</SideChatFrame>
	);
	return withoutScripts(
		renderToStaticMarkup(
			<QueryClientProvider client={new QueryClient()}>
				<ReferenceContext.Provider value={{ threads: THREADS }}>
					<div
						style={{
							display: "flex",
							flexDirection: stacked ? "column" : "row",
							height: "100vh",
						}}
					>
						<section
							className="welcome-panel"
							data-layout="chat"
							data-measure="main"
							style={{ flex: stacked ? "1 1 50%" : "1 1 60%", minWidth: 0 }}
						>
							<div className="welcome-content" data-layout="chat">
								<Chat />
							</div>
						</section>
						<aside
							className="workspace-inspector"
							data-measure="side"
							style={{ flex: stacked ? "1 1 50%" : "0 0 40%", minHeight: 0 }}
						>
							{side}
						</aside>
					</div>
				</ReferenceContext.Provider>
			</QueryClientProvider>,
		),
	);
}
